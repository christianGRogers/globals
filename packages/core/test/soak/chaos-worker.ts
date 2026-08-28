import { parentPort, workerData } from "node:worker_threads";

import { ArenaReader } from "../../src/reader.js";
import { ArenaCorruptError, NoReaderSlotError, StaleSnapshotError } from "../../src/errors.js";
import { checkState } from "./invariant.js";

/**
 * A simulated window.
 *
 * It attaches, reads for a while, and then leaves in one of three ways, chosen by the
 * parent:
 *
 *   close    detaches cleanly, which is a window being closed
 *   reload   detaches and reattaches, which is a renderer discarding its heap
 *   crash    stops answering without detaching, which is a renderer that died holding a pin
 *
 * The crash case is the one that matters. It leaves a claimed slot with a pinned epoch and
 * nothing in the arena notices, which is exactly what the liveness detector exists for.
 */

interface WorkerInput {
  readonly buffer: SharedArrayBuffer;
  readonly id: number;
}

export interface ChaosReport {
  readonly id: number;
  readonly reads: number;
  readonly inconsistentReads: number;
  readonly staleSnapshots: number;
  readonly corruptions: number;
  readonly attaches: number;
  readonly slotExhaustions: number;
  readonly lastError: string | null;
}

const input = workerData as WorkerInput;

let reader: ArenaReader | undefined;
let reads = 0;
let inconsistentReads = 0;
let staleSnapshots = 0;
let corruptions = 0;
let attaches = 0;
let slotExhaustions = 0;
let lastError: string | null = null;
let frozen = false;
let running = true;

function report(): ChaosReport {
  return {
    id: input.id,
    reads,
    inconsistentReads,
    staleSnapshots,
    corruptions,
    attaches,
    slotExhaustions,
    lastError,
  };
}

function attach(): void {
  try {
    reader = ArenaReader.attach(input.buffer);
    attaches += 1;
  } catch (error) {
    if (error instanceof NoReaderSlotError) {
      // Expected under churn when the reaper has not caught up yet. A window that cannot
      // attach retries rather than failing, which is what a real integration does.
      slotExhaustions += 1;
      reader = undefined;
      return;
    }
    throw error;
  }
}

function detach(): void {
  reader?.detach();
  reader = undefined;
}

parentPort?.on("message", (message: { command?: string }) => {
  switch (message.command) {
    case "close":
      running = false;
      detach();
      parentPort?.postMessage({ final: report() });
      return;
    case "reload":
      // A reload discards the heap. The clean version releases the slot first.
      detach();
      attach();
      return;
    case "freeze":
      // Stop reading without releasing anything. The reader keeps its slot and its pinned
      // epoch, which is what a hung renderer looks like from the arena.
      frozen = true;
      return;
    case "thaw":
      frozen = false;
      return;
    case "report":
      parentPort?.postMessage({ progress: report() });
      return;
    default:
      return;
  }
});

attach();

function tick(): void {
  if (!running) return;

  if (!frozen) {
    if (reader === undefined) attach();

    for (let i = 0; i < 40 && reader !== undefined; i += 1) {
      try {
        const snapshot = reader.acquire();
        const value = snapshot.toJSON();
        reads += 1;
        const mismatch = checkState(snapshot.versionId, value);
        if (mismatch !== undefined) {
          inconsistentReads += 1;
          lastError = `version ${snapshot.versionId} field ${mismatch.field}`;
        }
      } catch (error) {
        if (error instanceof StaleSnapshotError) {
          staleSnapshots += 1;
        } else if (error instanceof ArenaCorruptError) {
          corruptions += 1;
          lastError = error.message;
        } else {
          corruptions += 1;
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  setTimeout(tick, 1);
}

tick();
