import type { SharedArena } from "./arena.js";
import { NoReaderSlotError } from "./errors.js";
import {
  Header,
  READER_SLOT_WORDS,
  ReaderSlot,
  SLOT_CLAIMED,
  SLOT_FREE,
  WORD,
} from "./layout.js";

/**
 * The reader table.
 *
 * One slot per reader, claimed with a compare and exchange so two processes racing for the
 * same slot cannot both win. A slot carries four words: state, generation, pinned epoch,
 * and a heartbeat counter.
 *
 * The generation exists for the reload case. A renderer that reloads discards its heap
 * while its slot is still claimed. When the owner declares that reader dead and frees the
 * slot, the next claimant bumps the generation, so a snapshot taken by the previous
 * occupant can be recognised as belonging to a different reader and fails closed.
 */
export class ReaderTable {
  readonly #arena: SharedArena;

  constructor(arena: SharedArena) {
    this.#arena = arena;
  }

  get capacity(): number {
    return this.#arena.geometry.maxReaders;
  }

  #wordIndex(slot: number, field: number): number {
    return (
      this.#arena.geometry.readerTableOffset / WORD + slot * READER_SLOT_WORDS + field
    );
  }

  /** Claim a free slot. Throws when every slot is taken rather than silently sharing one. */
  claim(): { slot: number; generation: number } {
    const words = this.#arena.words;
    for (let slot = 0; slot < this.capacity; slot += 1) {
      const stateIndex = this.#wordIndex(slot, ReaderSlot.State);
      if (Atomics.compareExchange(words, stateIndex, SLOT_FREE, SLOT_CLAIMED) !== SLOT_FREE) {
        continue;
      }
      const generation =
        Atomics.add(words, this.#wordIndex(slot, ReaderSlot.Generation), 1) + 1;
      Atomics.store(words, this.#wordIndex(slot, ReaderSlot.Epoch), 0);
      Atomics.store(words, this.#wordIndex(slot, ReaderSlot.Heartbeat), 0);
      return { slot, generation };
    }
    throw new NoReaderSlotError(this.capacity);
  }

  /**
   * Release a slot. Unpins first, so a writer that observes the release can immediately
   * reclaim the version this reader was holding.
   */
  release(slot: number): void {
    const words = this.#arena.words;
    Atomics.store(words, this.#wordIndex(slot, ReaderSlot.Epoch), 0);
    Atomics.store(words, this.#wordIndex(slot, ReaderSlot.State), SLOT_FREE);
  }

  /** Pin this reader to a version. One atomic store, which is the whole cost of entering. */
  pin(slot: number, versionId: number): void {
    Atomics.store(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Epoch), versionId);
  }

  unpin(slot: number): void {
    Atomics.store(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Epoch), 0);
  }

  pinnedEpoch(slot: number): number {
    return Atomics.load(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Epoch));
  }

  generation(slot: number): number {
    return Atomics.load(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Generation));
  }

  isClaimed(slot: number): boolean {
    return (
      Atomics.load(this.#arena.words, this.#wordIndex(slot, ReaderSlot.State)) === SLOT_CLAIMED
    );
  }

  beat(slot: number): void {
    Atomics.add(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Heartbeat), 1);
  }

  heartbeat(slot: number): number {
    return Atomics.load(this.#arena.words, this.#wordIndex(slot, ReaderSlot.Heartbeat));
  }

  /**
   * The oldest version any reader is pinned to, or `Infinity` when nothing is pinned.
   * Everything strictly older can be reclaimed.
   *
   * This is a scan of the table on each commit. With a table of 32 slots that is 32 atomic
   * loads, which is cheaper than maintaining a shared minimum that every reader would have
   * to update on entry and exit.
   */
  minimumPinnedEpoch(): number {
    const words = this.#arena.words;
    let minimum = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (Atomics.load(words, this.#wordIndex(slot, ReaderSlot.State)) !== SLOT_CLAIMED) continue;
      const epoch = Atomics.load(words, this.#wordIndex(slot, ReaderSlot.Epoch));
      if (epoch !== 0 && epoch < minimum) minimum = epoch;
    }
    return minimum;
  }

  /** Every claimed slot, for liveness checks and diagnostics. */
  claimedSlots(): Array<{ slot: number; epoch: number; generation: number; heartbeat: number }> {
    const out = [];
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (!this.isClaimed(slot)) continue;
      out.push({
        slot,
        epoch: this.pinnedEpoch(slot),
        generation: this.generation(slot),
        heartbeat: this.heartbeat(slot),
      });
    }
    return out;
  }

  /**
   * Force a slot free. Used by the owner once it has declared a reader dead, and only
   * then. A live reader whose slot is taken this way will fail its next validity check and
   * fall back to reacquiring, which is the fail closed path rather than a crash.
   */
  forceRelease(slot: number): void {
    const words = this.#arena.words;
    Atomics.store(words, this.#wordIndex(slot, ReaderSlot.Epoch), 0);
    Atomics.add(words, this.#wordIndex(slot, ReaderSlot.Generation), 1);
    Atomics.store(words, this.#wordIndex(slot, ReaderSlot.State), SLOT_FREE);
  }

  ownerHeartbeat(): number {
    return this.#arena.loadHeader(Header.OwnerHeartbeat);
  }
}
