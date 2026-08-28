import type { ArenaOwner } from "./owner.js";
import type { ReaderTable } from "./readers.js";

/**
 * Liveness detection for readers.
 *
 * A renderer that reloads discards its heap while its slot in the reader table is still
 * claimed and, worse, while its epoch is still pinned. Nothing in the arena notices, so
 * retention grows until the ring wraps. A crashed renderer is the same case without the
 * reload.
 *
 * The detector is deliberately conservative. Reclaiming a slot from a reader that is merely
 * slow costs that reader a StaleSnapshotError and a reacquire, which is recoverable but
 * pointless. So a reader is declared dead only after its heartbeat has failed to move across
 * several consecutive ticks while it was holding a pin.
 *
 * This lives in the core rather than the Electron package because it is the same problem in
 * a worker thread, and because it can be tested without a window manager.
 */

export interface LivenessOptions {
  /** How often to sample, in milliseconds. */
  intervalMs?: number;
  /** Consecutive unchanged samples before a pinned reader is declared dead. */
  missesBeforeDead?: number;
  /** Called when a slot is reclaimed, for logging and metrics. */
  onReaped?: (slot: number, detail: { epoch: number; generation: number }) => void;
}

const DEFAULTS = {
  intervalMs: 1000,
  missesBeforeDead: 5,
} satisfies Required<Omit<LivenessOptions, "onReaped">>;

interface SlotSample {
  heartbeat: number;
  misses: number;
  generation: number;
}

export class LivenessMonitor {
  readonly #owner: ArenaOwner;
  readonly #table: ReaderTable;
  readonly #intervalMs: number;
  readonly #missesBeforeDead: number;
  readonly #onReaped: LivenessOptions["onReaped"];
  readonly #samples = new Map<number, SlotSample>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reaped = 0;

  constructor(owner: ArenaOwner, options: LivenessOptions = {}) {
    this.#owner = owner;
    this.#table = owner.readers;
    this.#intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.#missesBeforeDead = options.missesBeforeDead ?? DEFAULTS.missesBeforeDead;
    this.#onReaped = options.onReaped;
  }

  get reapedCount(): number {
    return this.#reaped;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    // Do not hold the process open. A liveness timer is a housekeeping detail, and an
    // application that has nothing else to do should be allowed to exit.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One sampling pass. Exposed so tests can drive it without waiting on a timer, and so an
   * integration can run it on a window lifecycle event rather than only on a clock.
   */
  tick(): void {
    this.#owner.beat();
    const seen = new Set<number>();

    for (const reader of this.#table.claimedSlots()) {
      seen.add(reader.slot);
      const previous = this.#samples.get(reader.slot);

      if (previous === undefined || previous.generation !== reader.generation) {
        // A new claimant, or the same slot reclaimed by someone else. Start fresh.
        this.#samples.set(reader.slot, {
          heartbeat: reader.heartbeat,
          misses: 0,
          generation: reader.generation,
        });
        continue;
      }

      // An unpinned reader costs nothing, so it is not worth reaping however idle it is.
      if (reader.epoch === 0 || reader.heartbeat !== previous.heartbeat) {
        previous.heartbeat = reader.heartbeat;
        previous.misses = 0;
        continue;
      }

      previous.misses += 1;
      if (previous.misses < this.#missesBeforeDead) continue;

      this.#table.forceRelease(reader.slot);
      this.#samples.delete(reader.slot);
      this.#reaped += 1;
      this.#onReaped?.(reader.slot, { epoch: reader.epoch, generation: reader.generation });
    }

    for (const slot of this.#samples.keys()) {
      if (!seen.has(slot)) this.#samples.delete(slot);
    }

    // Reclaim immediately after reaping, so the memory a dead reader was pinning is returned
    // in the same pass rather than at the next commit.
    this.#owner.reclaim();
  }

  /**
   * Reclaim a slot straight away, for a window the integration knows is gone.
   *
   * A close or crash event is better evidence than any number of missed heartbeats, so an
   * integration that has one should use it rather than waiting for the detector.
   */
  reapSlot(slot: number): void {
    this.#table.forceRelease(slot);
    this.#samples.delete(slot);
    this.#reaped += 1;
    this.#owner.reclaim();
  }
}
