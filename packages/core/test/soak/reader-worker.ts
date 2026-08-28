import { parentPort, workerData } from "node:worker_threads";

import { ArenaReader } from "../../src/reader.js";
import { ArenaCorruptError, StaleSnapshotError } from "../../src/errors.js";
import { expectedValueFor } from "./invariant.js";

interface WorkerInput {
  readonly buffer: SharedArrayBuffer;
  readonly id: number;
  readonly reportEveryMs: number;
}

export interface ReaderReport {
  readonly id: number;
  readonly reads: number;
  readonly distinctVersions: number;
  /** A decoded value that did not match what its version id says it must be. */
  readonly inconsistentReads: number;
  /** Expected under load: the reader fell behind the retention cap and failed closed. */
  readonly staleSnapshots: number;
  /** Never expected. A decode found something a correct writer cannot produce. */
  readonly corruptions: number;
  /** Never expected. A version id that went backwards. */
  readonly versionRegressions: number;
  readonly lastVersion: number;
  readonly lastError: string | null;
}

const input = workerData as WorkerInput;
const reader = ArenaReader.attach(input.buffer);

let reads = 0;
let distinctVersions = 0;
let inconsistentReads = 0;
let staleSnapshots = 0;
let corruptions = 0;
let versionRegressions = 0;
let lastVersion = 0;
let lastError: string | null = null;
let running = true;

function report(): ReaderReport {
  return {
    id: input.id,
    reads,
    distinctVersions,
    inconsistentReads,
    staleSnapshots,
    corruptions,
    versionRegressions,
    lastVersion,
    lastError,
  };
}

parentPort?.on("message", (message: { stop?: boolean }) => {
  if (message.stop) {
    running = false;
    parentPort?.postMessage({ final: report() });
  }
});

let nextReportAt = Date.now() + input.reportEveryMs;

function tick(): void {
  const deadline = Date.now() + 20;
  while (Date.now() < deadline && running) {
    for (let i = 0; i < 500; i += 1) {
      try {
        const snapshot = reader.acquire();
        const value = snapshot.value;
        reads += 1;

        if (snapshot.versionId !== lastVersion) {
          if (snapshot.versionId < lastVersion) versionRegressions += 1;
          lastVersion = snapshot.versionId;
          distinctVersions += 1;
        }

        // The invariant: the committed value is a pure function of its version id, so any
        // mismatch means the root tag, the root payload, and the version id were not read
        // from the same commit.
        const expected = expectedValueFor(snapshot.versionId);
        if (!Object.is(value, expected)) inconsistentReads += 1;
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

  if (Date.now() >= nextReportAt) {
    nextReportAt = Date.now() + input.reportEveryMs;
    parentPort?.postMessage({ progress: report() });
  }

  if (running) setImmediate(tick);
}

tick();
