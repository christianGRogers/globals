import { SharedArena } from "./arena.js";
import { ReaderTable } from "./readers.js";
import { RetainedRing } from "./retained.js";
import { Header } from "./layout.js";
import { StaleSnapshotError } from "./errors.js";
import { decodeValue, type Slot } from "./values.js";

/**
 * How many times a reader retries the seqlock before it gives up on acquiring a fresh
 * version. The window a commit holds the sequence odd is a handful of stores, so a reader
 * that spins this many times is looking at a stalled or hostile writer, not contention.
 */
const MAX_SPIN = 128;

export interface SnapshotInfo {
  readonly versionId: number;
  readonly ownerGeneration: number;
}

/**
 * A pinned version.
 *
 * Holding one guarantees the graph beneath it cannot change, because the writer never
 * mutates a published node. It does not guarantee the version stays retained forever: past
 * the retention cap the owner force advances, and the next decode raises
 * StaleSnapshotError rather than reading recycled memory.
 */
export class Snapshot {
  readonly versionId: number;
  readonly ownerGeneration: number;
  readonly #reader: ArenaReader;
  readonly #slot: Slot;
  #released = false;

  constructor(reader: ArenaReader, versionId: number, ownerGeneration: number, slot: Slot) {
    this.#reader = reader;
    this.versionId = versionId;
    this.ownerGeneration = ownerGeneration;
    this.#slot = slot;
  }

  get released(): boolean {
    return this.#released;
  }

  /**
   * The root value. Synchronous, no await, no round trip. This is the whole product.
   *
   * Validated on both sides of the decode. The check before it rejects a version that is
   * already gone. The check after it is the one that matters: the owner raises the reclaim
   * floor before it frees anything, so a version that is still above the floor once the
   * decode has finished cannot have been freed while the decode was running. Validating
   * only beforehand leaves a window in which a forced reclaim recycles the block and the
   * reader returns a well formed but wrong value, which the soak harness found in about two
   * reads out of four million.
   */
  get value(): unknown {
    this.validate();
    const decoded = decodeValue(this.#reader.arena, this.#slot);
    this.validate();
    return decoded;
  }

  /** The root slot, for callers decoding lazily rather than eagerly. */
  get root(): Slot {
    this.validate();
    return this.#slot;
  }

  /**
   * Prove this version is still retained. Two atomic loads and two comparisons, run on both
   * sides of every decode. Cheap enough to sit on the read path, and the only thing standing
   * between a stalled reader and freed memory.
   */
  validate(): void {
    if (this.isValid()) return;
    throw new StaleSnapshotError(this.versionId, this.#reader.reclaimFloor());
  }

  /**
   * True when this snapshot can still be decoded. Never throws, and never constructs an
   * error object, because it runs twice per read and a try/catch around the throwing form
   * kept the whole path out of the optimising compiler.
   */
  isValid(): boolean {
    return (
      !this.#released &&
      this.versionId >= this.#reader.reclaimFloor() &&
      this.#reader.ownerGeneration() === this.ownerGeneration
    );
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#reader.releaseSnapshot(this);
  }
}

export interface ReaderOptions {
  /** Bump the heartbeat on every acquire so the owner can tell this reader is alive. */
  heartbeat?: boolean;
}

/**
 * A reader.
 *
 * Attaching claims one slot in the reader table. Acquiring a snapshot is a seqlock read of
 * the root, one atomic store to publish the pinned epoch, and one atomic load to confirm
 * the version is above the reclaim floor. Nothing here blocks, allocates a promise, or
 * sends a message.
 */
export class ArenaReader {
  readonly arena: SharedArena;
  readonly slot: number;
  readonly generation: number;
  readonly #table: ReaderTable;
  readonly #ring: RetainedRing;
  readonly #heartbeat: boolean;
  /**
   * The header view, held directly.
   *
   * Every hop on the read path costs: `this.arena.loadHeader(field)` is a property load, a
   * method call, and a private field read before the atomic load itself. A read validates
   * four times per value, so holding the array here rather than reaching through the arena
   * on each one is worth the small duplication.
   */
  #words: Int32Array;
  #current: Snapshot | undefined;
  #detached = false;

  private constructor(arena: SharedArena, options: ReaderOptions) {
    this.arena = arena;
    this.#words = arena.words;
    this.#table = new ReaderTable(arena);
    this.#ring = new RetainedRing(arena);
    this.#heartbeat = options.heartbeat ?? true;
    const claim = this.#table.claim();
    this.slot = claim.slot;
    this.generation = claim.generation;
  }

  static attach(buffer: SharedArrayBuffer, options: ReaderOptions = {}): ArenaReader {
    return new ArenaReader(SharedArena.attach(buffer), options);
  }

  get detached(): boolean {
    return this.#detached;
  }

  reclaimFloor(): number {
    return Atomics.load(this.#words, Header.ReclaimFloor);
  }

  ownerGeneration(): number {
    return Atomics.load(this.#words, Header.OwnerGeneration);
  }

  /** The version the owner has currently published, without pinning it. */
  publishedVersion(): number {
    return Atomics.load(this.#words, Header.VersionId);
  }

  /**
   * Acquire the current version and pin it.
   *
   * Returns the snapshot already held when the owner has not committed since, so a render
   * loop that calls this every frame does not churn pins.
   */
  acquire(): Snapshot {
    if (this.#detached) throw new Error("this reader has been detached");

    const held = this.#current;
    if (held !== undefined && held.versionId === this.publishedVersion() && held.isValid()) {
      return held;
    }

    // Only a version change can require a longer view, so the growth check belongs here
    // rather than on every header access.
    this.arena.refresh();
    this.#words = this.arena.words;

    if (this.#heartbeat) this.#table.beat(this.slot);

    for (let attempt = 0; attempt < MAX_SPIN; attempt += 1) {
      const words = this.#words;
      const before = Atomics.load(words, Header.Sequence);
      if ((before & 1) !== 0) continue; // a commit is in progress

      const tag = Atomics.load(words, Header.RootTag);
      const payload = Atomics.load(words, Header.RootPayload);
      const versionId = Atomics.load(words, Header.VersionId);
      const ownerGeneration = Atomics.load(words, Header.OwnerGeneration);

      if (Atomics.load(words, Header.Sequence) !== before) continue; // torn, retry

      // Publish the pin before checking the floor. The owner publishes the floor before it
      // frees anything and rescans afterwards, so one of the two checks always catches a
      // race. See ArenaOwner.reclaim for the full argument.
      this.#table.pin(this.slot, versionId);

      if (versionId < this.reclaimFloor()) continue;
      if (!this.#ring.isLive(versionId)) continue;

      const snapshot = new Snapshot(this, versionId, ownerGeneration, { tag, payload });
      this.#current = snapshot;
      return snapshot;
    }

    // The bounded spin is exhausted. Fall back to the last good snapshot when it is still
    // valid, which keeps a render alive through a pathological writer rather than throwing
    // into a render path that cannot handle it.
    this.#table.unpin(this.slot);
    if (held !== undefined && held.isValid()) {
      this.#table.pin(this.slot, held.versionId);
      return held;
    }
    throw new StaleSnapshotError(this.publishedVersion(), this.reclaimFloor());
  }

  /** Read the current root value. The synchronous read the whole library exists for. */
  read(): unknown {
    return this.acquire().value;
  }

  releaseSnapshot(snapshot: Snapshot): void {
    if (this.#current === snapshot) {
      this.#current = undefined;
      this.#table.unpin(this.slot);
    }
  }

  /** Release the pin and the reader slot. Always call this before dropping a reader. */
  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#current = undefined;
    this.#table.release(this.slot);
  }

  stats(): {
    slot: number;
    generation: number;
    pinnedEpoch: number;
    publishedVersion: number;
    reclaimFloor: number;
  } {
    return {
      slot: this.slot,
      generation: this.generation,
      pinnedEpoch: this.#table.pinnedEpoch(this.slot),
      publishedVersion: this.publishedVersion(),
      reclaimFloor: this.reclaimFloor(),
    };
  }
}
