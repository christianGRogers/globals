/**
 * The multi process soak.
 *
 * A writer commits at full rate while N readers verify every snapshot against an invariant
 * that depends only on the version id. This harness outlives phase 1 and gates every later
 * release: a change to the arena or to reclamation is not ready to merge without a run.
 *
 *   node packages/core/dist/test/soak/run-soak.js --readers 8 --seconds 3600
 */
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ArenaOwner } from "../../src/owner.js";
import { expectedValueFor } from "./invariant.js";
import type { ReaderReport } from "./reader-worker.js";

interface Sample {
  readonly atMs: number;
  readonly versionId: number;
  readonly bumpPointer: number;
  readonly liveBytes: number;
  readonly freeListBytes: number;
  readonly strandedBytes: number;
  readonly internedStrings: number;
  readonly pendingGarbageVersions: number;
  readonly reclaimFloor: number;
  readonly minimumPinnedEpoch: number;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    readers: { type: "string", default: "8" },
    seconds: { type: "string", default: "120" },
    report: { type: "string" },
    retained: { type: "string", default: "64" },
    "sample-ms": { type: "string", default: "1000" },
  },
});

const readerCount = Number(values.readers);
const durationSeconds = Number(values.seconds);
const retainedVersions = Number(values.retained);
const sampleMs = Number(values["sample-ms"]);

const owner = ArenaOwner.create({
  byteLength: 1 << 20,
  maxByteLength: 1 << 26,
  maxReaders: Math.max(readerCount + 2, 8),
  retainedVersions,
});

const workerUrl = new URL("./reader-worker.js", import.meta.url);
const reports = new Map<number, ReaderReport>();
const samples: Sample[] = [];

const workers = Array.from({ length: readerCount }, (_unused, id) => {
  const worker = new Worker(workerUrl, {
    workerData: { buffer: owner.buffer, id, reportEveryMs: 1000 },
  });
  worker.on("message", (message: { progress?: ReaderReport; final?: ReaderReport }) => {
    const report = message.final ?? message.progress;
    if (report) reports.set(report.id, report);
  });
  worker.on("error", (error) => {
    console.error(`reader ${id} crashed: ${error.message}`);
    process.exitCode = 1;
  });
  return worker;
});

function sample(): void {
  const stats = owner.stats();
  samples.push({
    atMs: Date.now(),
    versionId: stats.versionId,
    bumpPointer: stats.bumpPointer,
    liveBytes: stats.liveBytes,
    freeListBytes: stats.freeListBytes,
    strandedBytes: stats.strandedBytes,
    internedStrings: stats.internedStrings,
    pendingGarbageVersions: stats.pendingGarbageVersions,
    reclaimFloor: stats.reclaimFloor,
    minimumPinnedEpoch: stats.minimumPinnedEpoch,
  });
}

const startedAt = Date.now();
const endsAt = startedAt + durationSeconds * 1000;
let nextSampleAt = startedAt + sampleMs;
let nextProgressAt = startedAt + 10_000;

function writeBatch(): void {
  // Commit in batches, then yield, so the event loop can drain worker messages. A writer
  // that never yields starves its own reporting and makes the run unobservable.
  for (let i = 0; i < 2000; i += 1) {
    owner.commit(expectedValueFor(owner.versionId + 1));
  }
  owner.beat();

  const now = Date.now();
  if (now >= nextSampleAt) {
    nextSampleAt = now + sampleMs;
    sample();
  }
  if (now >= nextProgressAt) {
    nextProgressAt = now + 10_000;
    const elapsed = Math.round((now - startedAt) / 1000);
    const reads = [...reports.values()].reduce((sum, r) => sum + r.reads, 0);
    console.log(
      `  ${String(elapsed).padStart(5)}s  version ${owner.versionId}` +
        `  reads ${reads}  live ${owner.stats().liveBytes}B` +
        `  bump ${owner.stats().bumpPointer}B`,
    );
  }

  if (now < endsAt) setImmediate(writeBatch);
  else void finish();
}

async function finish(): Promise<void> {
  sample();
  for (const worker of workers) worker.postMessage({ stop: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await Promise.all(workers.map((worker) => worker.terminate()));

  const readerReports = [...reports.values()];
  const totals = readerReports.reduce(
    (accumulator, report) => ({
      reads: accumulator.reads + report.reads,
      distinctVersions: accumulator.distinctVersions + report.distinctVersions,
      inconsistentReads: accumulator.inconsistentReads + report.inconsistentReads,
      staleSnapshots: accumulator.staleSnapshots + report.staleSnapshots,
      corruptions: accumulator.corruptions + report.corruptions,
      versionRegressions: accumulator.versionRegressions + report.versionRegressions,
    }),
    {
      reads: 0,
      distinctVersions: 0,
      inconsistentReads: 0,
      staleSnapshots: 0,
      corruptions: 0,
      versionRegressions: 0,
    },
  );

  // Memory growth is judged over the second half of the run, after the string pool has
  // been interned and the free lists have reached their working set. Growth there is a
  // leak, growth in the first half is warmup.
  const half = samples.slice(Math.floor(samples.length / 2));
  const first = half[0];
  const last = half[half.length - 1];
  const bumpGrowth = first && last ? last.bumpPointer - first.bumpPointer : 0;
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    elapsedSeconds,
    readers: readerCount,
    retainedVersions,
    commits: owner.versionId,
    commitsPerSecond: Math.round(owner.versionId / elapsedSeconds),
    readsPerSecond: Math.round(totals.reads / elapsedSeconds),
    totals,
    bumpGrowthInSecondHalfBytes: bumpGrowth,
    finalStats: owner.stats(),
    samples,
  };

  console.log("\nsoak summary\n");
  console.log(`  duration            ${elapsedSeconds.toFixed(1)}s`);
  console.log(`  readers             ${readerCount}`);
  console.log(`  commits             ${summary.commits} (${summary.commitsPerSecond}/s)`);
  console.log(`  reads               ${totals.reads} (${summary.readsPerSecond}/s)`);
  console.log(`  distinct versions   ${totals.distinctVersions}`);
  console.log(`  inconsistent reads  ${totals.inconsistentReads}`);
  console.log(`  version regressions ${totals.versionRegressions}`);
  console.log(`  corruptions         ${totals.corruptions}`);
  console.log(`  stale snapshots     ${totals.staleSnapshots}`);
  console.log(`  interned strings    ${owner.stats().internedStrings}`);
  console.log(`  live bytes          ${owner.stats().liveBytes}`);
  console.log(`  stranded bytes      ${owner.stats().strandedBytes}`);
  console.log(`  bump growth, 2nd half ${bumpGrowth} bytes`);

  if (values.report) {
    await mkdir(dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(summary, null, 2));
    console.log(`\n  report written to ${values.report}`);
  }

  const failures: string[] = [];
  if (totals.inconsistentReads > 0) {
    failures.push(`${totals.inconsistentReads} inconsistent reads`);
  }
  if (totals.corruptions > 0) failures.push(`${totals.corruptions} corrupt decodes`);
  if (totals.versionRegressions > 0) {
    failures.push(`${totals.versionRegressions} version regressions`);
  }
  if (bumpGrowth > 0) failures.push(`arena grew by ${bumpGrowth} bytes in the second half`);
  if (totals.reads === 0) failures.push("no reads were recorded, the harness did not run");

  if (failures.length > 0) {
    console.error(`\ngate: FAIL, ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\ngate: PASS, zero inconsistent reads and no unbounded growth");
  process.exit(0);
}

console.log(
  `soak: ${readerCount} readers, ${durationSeconds}s, ${retainedVersions} retained versions\n`,
);
setImmediate(writeBatch);
