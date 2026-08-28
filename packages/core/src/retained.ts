import type { SharedArena } from "./arena.js";
import {
  Header,
  RETAINED_SLOT_WORDS,
  RetainedSlot,
  RetainedState,
  WORD,
} from "./layout.js";

export interface RetainedVersion {
  readonly versionId: number;
  readonly rootTag: number;
  readonly rootPayload: number;
  readonly state: number;
}

/**
 * The retained version ring.
 *
 * The owner appends one entry per commit. Readers only read it, and they read it for one
 * reason: to prove that the version they are pinned to is still live before they decode
 * anything through it.
 *
 * The ring is bounded on purpose. A reader that stops advancing cannot pin memory forever,
 * because once the ring wraps the owner force reclaims the oldest entry and that reader
 * fails closed on its next decode. Unbounded retention would be the alternative, and it
 * turns one frozen window into an out of memory crash for the whole application.
 */
export class RetainedRing {
  readonly #arena: SharedArena;

  constructor(arena: SharedArena) {
    this.#arena = arena;
  }

  get capacity(): number {
    return this.#arena.geometry.retainedCapacity;
  }

  #wordIndex(index: number, field: number): number {
    return (
      this.#arena.geometry.retainedRingOffset / WORD + index * RETAINED_SLOT_WORDS + field
    );
  }

  #indexFor(versionId: number): number {
    // Version ids start at 1 and never wrap in practice: at one commit per millisecond a
    // 32 bit counter lasts 24 days, and the owner refuses to commit past the limit rather
    // than wrapping into ambiguity.
    return (versionId - 1) % this.capacity;
  }

  /** Owner only. Publish a version into the ring, overwriting the entry it wraps onto. */
  publish(versionId: number, rootTag: number, rootPayload: number): void {
    const words = this.#arena.words;
    const index = this.#indexFor(versionId);
    // Order matters: clear the state first so a reader cannot observe a new version id
    // beside the previous entry's root.
    Atomics.store(words, this.#wordIndex(index, RetainedSlot.State), RetainedState.Empty);
    Atomics.store(words, this.#wordIndex(index, RetainedSlot.RootTag), rootTag);
    Atomics.store(words, this.#wordIndex(index, RetainedSlot.RootPayload), rootPayload);
    Atomics.store(words, this.#wordIndex(index, RetainedSlot.VersionId), versionId);
    Atomics.store(words, this.#wordIndex(index, RetainedSlot.State), RetainedState.Live);
  }

  /** Owner only. Mark a version reclaimed. `forced` records that a reader was still pinned. */
  retire(versionId: number, forced: boolean): void {
    const index = this.#indexFor(versionId);
    const words = this.#arena.words;
    if (Atomics.load(words, this.#wordIndex(index, RetainedSlot.VersionId)) !== versionId) return;
    Atomics.store(
      words,
      this.#wordIndex(index, RetainedSlot.State),
      forced ? RetainedState.ForceReclaimed : RetainedState.Reclaimed,
    );
  }

  /**
   * The check every reader runs after publishing its epoch. Returns true only when the
   * version is still live in the ring, which proves the owner has not reclaimed the memory
   * beneath it.
   */
  isLive(versionId: number): boolean {
    if (versionId <= 0) return false;
    const words = this.#arena.words;
    const index = this.#indexFor(versionId);
    return (
      Atomics.load(words, this.#wordIndex(index, RetainedSlot.VersionId)) === versionId &&
      Atomics.load(words, this.#wordIndex(index, RetainedSlot.State)) === RetainedState.Live
    );
  }

  read(versionId: number): RetainedVersion | undefined {
    const words = this.#arena.words;
    const index = this.#indexFor(versionId);
    if (Atomics.load(words, this.#wordIndex(index, RetainedSlot.VersionId)) !== versionId) {
      return undefined;
    }
    return {
      versionId,
      rootTag: Atomics.load(words, this.#wordIndex(index, RetainedSlot.RootTag)),
      rootPayload: Atomics.load(words, this.#wordIndex(index, RetainedSlot.RootPayload)),
      state: Atomics.load(words, this.#wordIndex(index, RetainedSlot.State)),
    };
  }

  /** Live versions, oldest first. Diagnostics and the debug panel use this. */
  live(): RetainedVersion[] {
    const words = this.#arena.words;
    const out: RetainedVersion[] = [];
    for (let index = 0; index < this.capacity; index += 1) {
      if (Atomics.load(words, this.#wordIndex(index, RetainedSlot.State)) !== RetainedState.Live) {
        continue;
      }
      out.push({
        versionId: Atomics.load(words, this.#wordIndex(index, RetainedSlot.VersionId)),
        rootTag: Atomics.load(words, this.#wordIndex(index, RetainedSlot.RootTag)),
        rootPayload: Atomics.load(words, this.#wordIndex(index, RetainedSlot.RootPayload)),
        state: RetainedState.Live,
      });
    }
    out.sort((a, b) => a.versionId - b.versionId);
    return out;
  }

  reclaimFloor(): number {
    return this.#arena.loadHeader(Header.ReclaimFloor);
  }
}
