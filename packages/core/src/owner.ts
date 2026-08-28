import { SharedArena } from "./arena.js";
import { Allocator } from "./allocator.js";
import { ReaderTable } from "./readers.js";
import { RetainedRing } from "./retained.js";
import { StringTable } from "./strings.js";
import { Header, VerifyMode, type VerifyModeValue } from "./layout.js";
import {
  collectBlocks,
  decodeValue,
  encodeValue,
  type EncodeContext,
  type Slot,
} from "./values.js";
import { createDraft, finalizeState } from "./draft.js";
import { Tag } from "./tags.js";
import { GlobalsError } from "./errors.js";

export interface OwnerOptions {
  /** Initial arena size in bytes. */
  byteLength?: number;
  /** Upper bound the buffer may grow to. Address space is reserved, not resident memory. */
  maxByteLength?: number;
  /** Reader slots. One per window, plus headroom for reloads that have not been reaped. */
  maxReaders?: number;
  /**
   * How many versions the ring retains. This bounds how far a stalled reader can hold
   * memory: past it, the owner force advances and that reader fails closed.
   */
  retainedVersions?: number;
  verify?: VerifyModeValue;
}

const DEFAULTS = {
  byteLength: 1 << 20,
  maxByteLength: 1 << 26,
  maxReaders: 32,
  retainedVersions: 64,
  verify: VerifyMode.Header,
} satisfies Required<OwnerOptions>;

export interface OwnerStats {
  readonly versionId: number;
  readonly commits: number;
  readonly forcedAdvances: number;
  readonly liveBytes: number;
  readonly bumpPointer: number;
  readonly capacityBytes: number;
  readonly freeListBytes: number;
  readonly strandedBytes: number;
  readonly internedStrings: number;
  readonly pendingGarbageVersions: number;
  readonly reclaimFloor: number;
  readonly claimedReaders: number;
  readonly minimumPinnedEpoch: number;
}

/**
 * The sole writer.
 *
 * In Electron this runs in the hidden owner window. In tests it runs on the main thread of
 * a plain Node process, which is exactly the point of keeping this package free of Electron
 * imports.
 *
 * The single writer property is load bearing. It removes allocator locking, it makes the
 * free lists safe to keep on the writer heap where no other window can corrupt them, and it
 * makes the commit sequence a plain store rather than a contended compare and exchange.
 */
export class ArenaOwner {
  readonly arena: SharedArena;
  readonly #allocator: Allocator;
  readonly #strings: StringTable;
  readonly #readers: ReaderTable;
  readonly #ring: RetainedRing;

  #versionId = 0;
  #currentSlot: Slot = { tag: 0, payload: 0 };
  /**
   * The oldest version a reader may still decode. Monotonic: once memory below a version
   * is freed, no later decision may lower the floor back over it.
   */
  #reclaimFloor = 0;
  /**
   * Blocks that became unreachable when a version was superseded, keyed by the version
   * that still referenced them. Insertion order is ascending by version, which the
   * reclamation scan relies on.
   */
  readonly #garbage = new Map<number, number[]>();

  private constructor(arena: SharedArena) {
    this.arena = arena;
    this.#allocator = new Allocator(arena, (minimum) => this.#growBuffer(minimum));
    this.#strings = new StringTable(arena, this.#allocator);
    this.#readers = new ReaderTable(arena);
    this.#ring = new RetainedRing(arena);
  }

  /** Allocate and format a new arena. */
  static create(options: OwnerOptions = {}): ArenaOwner {
    const settings = { ...DEFAULTS, ...options };
    if (settings.maxByteLength < settings.byteLength) {
      throw new GlobalsError("maxByteLength cannot be smaller than byteLength");
    }
    const buffer = new SharedArrayBuffer(settings.byteLength, {
      maxByteLength: settings.maxByteLength,
    });
    const arena = SharedArena.format(buffer, {
      maxReaders: settings.maxReaders,
      retainedCapacity: settings.retainedVersions,
      flags: settings.verify,
    });
    const owner = new ArenaOwner(arena);
    owner.commit(undefined);
    return owner;
  }

  /**
   * Adopt a buffer that a previous owner formatted. Bumps the owner generation so readers
   * attached to the dead owner can detect the change.
   *
   * The free lists cannot be recovered, so an adopted arena starts with a bump pointer
   * where the previous owner left it and no reusable blocks. That is acceptable because
   * adoption follows an owner crash, which is rare and already costs a rehydrate.
   */
  static adopt(buffer: SharedArrayBuffer): ArenaOwner {
    const arena = SharedArena.attach(buffer);
    arena.addHeader(Header.OwnerGeneration, 1);
    const owner = new ArenaOwner(arena);
    owner.#versionId = arena.loadHeader(Header.VersionId);
    owner.#reclaimFloor = arena.loadHeader(Header.ReclaimFloor);
    owner.#currentSlot = {
      tag: arena.loadHeader(Header.RootTag),
      payload: arena.loadHeader(Header.RootPayload),
    };
    return owner;
  }

  get buffer(): SharedArrayBuffer {
    return this.arena.buffer;
  }

  get versionId(): number {
    return this.#versionId;
  }

  get strings(): StringTable {
    return this.#strings;
  }

  get allocator(): Allocator {
    return this.#allocator;
  }

  get readers(): ReaderTable {
    return this.#readers;
  }

  get ring(): RetainedRing {
    return this.#ring;
  }

  /**
   * Encode `value`, publish it as the new root, and reclaim what the previous version was
   * keeping alive.
   *
   * The publication is a seqlock write. Readers never block on it: they observe an odd
   * sequence, spin briefly, and retry. The window is a handful of stores wide.
   */
  commit(value: unknown): number {
    const context = this.#newContext();

    let slot: Slot;
    try {
      slot = encodeValue(context, value);
    } catch (error) {
      // Encoding failed part way. Release what it allocated so a rejected write does not
      // leak, then let the caller see the original failure.
      for (const offset of context.allocated) this.#allocator.free(offset);
      throw error;
    }

    // A wholesale replacement shares nothing with the previous version, so everything the
    // old root reached is garbage once that version is unreadable.
    const retired = collectBlocks(this.arena, this.#currentSlot, context.retired);
    return this.#install(slot, retired);
  }

  /**
   * Apply a recipe to a draft of the current state and commit the result.
   *
   * This is the path that makes retention affordable. Only the paths the recipe touched are
   * rebuilt, so setting one field of a large object copies a handful of nodes rather than
   * the tree.
   *
   *     owner.update((draft) => {
   *       draft.users[3].name = "new name";
   *     });
   */
  update<T>(recipe: (draft: T) => void): number {
    const context = this.#newContext();
    const current = this.#currentSlot;

    if (current.tag !== Tag.Object && current.tag !== Tag.Array) {
      throw new GlobalsError(
        "update needs an object or array root. Commit one first, or use commit to replace " +
          "the root outright.",
      );
    }

    let slot: Slot;
    try {
      const draft = createDraft(context, current);
      recipe(draft.proxy as T);
      slot = finalizeState(context, draft.state);
    } catch (error) {
      for (const offset of context.allocated) this.#allocator.free(offset);
      throw error;
    }

    if (slot.tag === current.tag && slot.payload === current.payload) {
      // The recipe changed nothing. Publishing a version anyway would wake every window for
      // no reason.
      return this.#versionId;
    }

    return this.#install(slot, context.retired);
  }

  /**
   * The current state as a detached plain value.
   *
   * The owner reads through this rather than through a reader, because it already knows the
   * current root and does not need to pin anything: nothing can reclaim a version while the
   * only writer is inside a synchronous method.
   */
  readSnapshot(): unknown {
    return decodeValue(this.arena, this.#currentSlot);
  }

  #newContext(): EncodeContext {
    return {
      arena: this.arena,
      allocator: this.#allocator,
      strings: this.#strings,
      allocated: [],
      retired: [],
    };
  }

  #install(slot: Slot, retired: number[]): number {
    const previousVersion = this.#versionId;
    const version = previousVersion + 1;

    this.#evictForVersion(version);
    this.#publish(version, slot);

    if (previousVersion > 0 && retired.length > 0) {
      const existing = this.#garbage.get(previousVersion);
      if (existing) existing.push(...retired);
      else this.#garbage.set(previousVersion, retired);
    }

    this.#currentSlot = slot;
    this.#versionId = version;
    this.arena.addHeader(Header.StatCommits, 1);
    this.reclaim();
    return version;
  }

  #publish(version: number, slot: Slot): void {
    const arena = this.arena;
    // Odd sequence: a commit is in progress and readers must retry.
    arena.addHeader(Header.Sequence, 1);
    // The ring entry is written before the header so a reader that observes the new version
    // can always find it live in the ring.
    this.#ring.publish(version, slot.tag, slot.payload);
    arena.storeHeader(Header.RootTag, slot.tag);
    arena.storeHeader(Header.RootPayload, slot.payload);
    arena.storeHeader(Header.VersionId, version);
    // Even sequence: the root is stable again.
    arena.addHeader(Header.Sequence, 1);
  }

  /**
   * Reclaim every version that no reader can still be pinned to.
   *
   * The order below is the whole correctness argument, so it is written out rather than
   * left to be rediscovered:
   *
   *   1. Scan the reader table for the minimum pinned epoch.
   *   2. Publish the resulting floor.
   *   3. Scan again.
   *   4. Free only below the minimum of the two scans.
   *
   * Step 3 is what closes the race. A reader that pinned between steps 1 and 2 is seen by
   * the second scan. A reader that pinned after step 2 must load the floor after the store
   * that published it, sees its version is below the floor, and retries. There is no
   * interleaving in which a reader proceeds with a version this method then frees.
   */
  reclaim(): void {
    const firstScan = this.#readers.minimumPinnedEpoch();
    const boundary = Math.min(firstScan, this.#versionId);
    this.#raiseFloor(Number.isFinite(boundary) ? boundary : 0);

    const secondScan = this.#readers.minimumPinnedEpoch();
    const safeBelow = Math.min(boundary, secondScan);

    for (const [versionId, blocks] of this.#garbage) {
      if (versionId >= safeBelow) break;
      for (const offset of blocks) this.#allocator.free(offset);
      this.#garbage.delete(versionId);
      this.#ring.retire(versionId, false);
    }

    this.arena.storeHeader(Header.StatBytesLive, this.#allocator.stats().liveBytes);
  }

  /**
   * Raise the reclaim floor and publish it. Never lowers it: a reader that has been told a
   * version is gone must not later be told it is available again, because the memory
   * beneath it has already been handed to a different allocation.
   */
  #raiseFloor(value: number): void {
    if (value <= this.#reclaimFloor) return;
    this.#reclaimFloor = value;
    this.arena.storeHeader(Header.ReclaimFloor, value);
  }

  /**
   * The ring slot a new version will occupy may still hold a live version. Free it, even if
   * a reader is pinned to it.
   *
   * This is the bounded retention rule. The alternative is to let one frozen window grow
   * the arena without limit, which turns a stuck renderer into an out of memory crash for
   * the whole application. A reader that loses its version this way raises
   * StaleSnapshotError on its next decode and reacquires, which is a recoverable outcome.
   */
  #evictForVersion(version: number): void {
    const evicted = version - this.#ring.capacity;
    if (evicted < 1) return;

    const minimumPinned = this.#readers.minimumPinnedEpoch();
    if (minimumPinned <= evicted) this.arena.addHeader(Header.StatForcedAdvances, 1);

    // The floor rises before anything is freed. A reader that is part way through decoding
    // one of these versions revalidates after its decode and sees the raised floor, so it
    // reports a stale snapshot instead of returning a value read from reused memory. The
    // reverse order loses that: the reader would decode recycled bytes and revalidate
    // against a floor that had not moved yet.
    this.#raiseFloor(evicted + 1);

    for (const [versionId, blocks] of this.#garbage) {
      if (versionId > evicted) break;
      for (const offset of blocks) this.#allocator.free(offset);
      this.#garbage.delete(versionId);
      this.#ring.retire(versionId, versionId >= minimumPinned);
    }
  }

  /**
   * Grow the buffer. Every holder observes the new length, because a growable
   * SharedArrayBuffer reserves its maximum at allocation and grow() only publishes more of
   * it. Views made before the growth are refreshed lazily by SharedArena.
   */
  #growBuffer(minimumBytes: number): boolean {
    const buffer = this.arena.buffer;
    const maximum = buffer.maxByteLength ?? buffer.byteLength;
    if (!buffer.growable || buffer.byteLength >= maximum) return false;

    const wanted = Math.min(
      maximum,
      Math.max(buffer.byteLength * 2, buffer.byteLength + minimumBytes),
    );
    if (wanted <= buffer.byteLength) return false;

    buffer.grow(wanted);
    this.arena.refresh();
    this.arena.storeHeader(Header.CapacityBytes, this.arena.byteLength);
    return true;
  }

  /** Bump the owner heartbeat. Readers use it to detect an owner that has stopped. */
  beat(): void {
    this.arena.addHeader(Header.OwnerHeartbeat, 1);
  }

  stats(): OwnerStats {
    const allocator = this.#allocator.stats();
    const minimum = this.#readers.minimumPinnedEpoch();
    return {
      versionId: this.#versionId,
      commits: this.arena.loadHeader(Header.StatCommits),
      forcedAdvances: this.arena.loadHeader(Header.StatForcedAdvances),
      liveBytes: allocator.liveBytes,
      bumpPointer: allocator.bumpPointer,
      capacityBytes: allocator.capacityBytes,
      freeListBytes: allocator.freeListBytes,
      strandedBytes: this.#allocator.strandedBytes(),
      internedStrings: this.#strings.size,
      pendingGarbageVersions: this.#garbage.size,
      reclaimFloor: this.arena.loadHeader(Header.ReclaimFloor),
      claimedReaders: this.#readers.claimedSlots().length,
      minimumPinnedEpoch: Number.isFinite(minimum) ? minimum : 0,
    };
  }
}
