/**
 * The chaos harness.
 *
 * Simulated windows are opened, reloaded, frozen, and killed at random while a writer
 * commits continuously. It is the runtime agnostic half of the phase 3 exit criterion:
 * everything about window lifecycle that does not need a window manager.
 *
 *   node packages/core/dist/test/soak/run-chaos.js --windows 6 --seconds 120
 *
 * What it cannot cover is the Electron handshake itself, which needs a display. That half is
 * `packages/electron/test/chaos-app`, run by the electron-matrix workflow.
 */
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ArenaOwner } from "../../src/owner.js";
import { LivenessMonitor } from "../../src/liveness.js";
import { WHOLESALE_EVERY, expectedState, type SoakState } from "./invariant.js";
import type { ChaosReport } from "./chaos-worker.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    windows: { type: "string", default: "6" },
    seconds: { type: "string", default: "60" },
    slots: { type: "string", default: "12" },
    report: { type: "string" },
    seed: { type: "string", default: "20260827" },
  },
});

const windowCount = Number(values.windows);
const durationSeconds = Number(values.seconds);
const slots = Number(values.slots);

let seed = Number(values.seed) | 0;
function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return (seed >>> 0) / 2 ** 32;
}

const owner = ArenaOwner.create({
  byteLength: 1 << 20,
  maxByteLength: 1 << 26,
  // Deliberately fewer slots than the churn could want, so slot exhaustion and reaping are
  // both exercised rather than avoided by over provisioning.
  maxReaders: slots,
  retainedVersions: 32,
});
owner.commit(expectedState(owner.versionId + 1));

const reaped: number[] = [];
const liveness = new LivenessMonitor(owner, {
  intervalMs: 200,
  missesBeforeDead: 3,
  onReaped: (slot) => reaped.push(slot),
});
liveness.start();

const workerUrl = new URL("./chaos-worker.js", import.meta.url);
const reports = new Map<number, ChaosReport>();
const workers = new Map<number, Worker>();
const events = { opened: 0, closed: 0, reloaded: 0, frozen: 0, killed: 0 };

function open(id: number): void {
  const worker = new Worker(workerUrl, { workerData: { buffer: owner.buffer, id } });
  worker.on("message", (message: { progress?: ChaosReport; final?: ChaosReport }) => {
    const report = message.final ?? message.progress;
    if (report) reports.set(report.id, merge(reports.get(report.id), report));
  });
  worker.on("error", (error) => {
    console.error(`window ${id} crashed unexpectedly: ${error.message}`);
    process.exitCode = 1;
  });
  workers.set(id, worker);
  events.opened += 1;
}

function merge(previous: ChaosReport | undefined, next: ChaosReport): ChaosReport {
  if (previous === undefined) return next;
  // A window that is killed and reopened reuses its id, so counts accumulate rather than
  // being replaced by the fresh worker's smaller numbers.
  if (next.reads >= previous.reads) return next;
  return {
    ...next,
    reads: previous.reads + next.reads,
    inconsistentReads: previous.inconsistentReads + next.inconsistentReads,
    staleSnapshots: previous.staleSnapshots + next.staleSnapshots,
    corruptions: previous.corruptions + next.corruptions,
    attaches: previous.attaches + next.attaches,
    slotExhaustions: previous.slotExhaustions + next.slotExhaustions,
    lastError: next.lastError ?? previous.lastError,
  };
}

for (let id = 0; id < windowCount; id += 1) open(id);

const startedAt = Date.now();
const endsAt = startedAt + durationSeconds * 1000;

function writeBatch(): void {
  for (let i = 0; i < 100; i += 1) {
    const next = owner.versionId + 1;
    const state = expectedState(next);
    if (next % WHOLESALE_EVERY === 0) {
      owner.commit(state);
      continue;
    }
    owner.update((draft: SoakState) => {
      draft.version = state.version;
      draft.ratio = state.ratio;
      draft.tag = state.tag;
      draft.list[0] = state.list[0] as number;
      draft.nested.x = state.nested.x;
      draft.nested.flag = state.nested.flag;
      draft.nested.label = state.nested.label;
    });
  }
  if (Date.now() < endsAt) setImmediate(writeBatch);
}

/** One chaotic act, chosen at random, every 150 ms. */
function disturb(): void {
  if (Date.now() >= endsAt) return;

  const ids = [...workers.keys()];
  const id = ids[Math.floor(random() * ids.length)];
  const roll = random();

  if (id !== undefined) {
    const worker = workers.get(id);
    if (roll < 0.3) {
      worker?.postMessage({ command: "reload" });
      events.reloaded += 1;
    } else if (roll < 0.5) {
      worker?.postMessage({ command: "freeze" });
      events.frozen += 1;
      setTimeout(() => worker?.postMessage({ command: "thaw" }), 800).unref?.();
    } else if (roll < 0.65) {
      // The important case. Terminating without a detach leaves a claimed slot and a pinned
      // epoch behind, which only the liveness detector can clean up.
      void worker?.terminate();
      workers.delete(id);
      events.killed += 1;
      setTimeout(() => open(id), 300).unref?.();
    } else if (roll < 0.75) {
      worker?.postMessage({ command: "close" });
      workers.delete(id);
      events.closed += 1;
      setTimeout(() => open(id), 200).unref?.();
    } else {
      worker?.postMessage({ command: "report" });
    }
  }

  setTimeout(disturb, 150).unref?.();
}

async function finish(): Promise<void> {
  for (const worker of workers.values()) worker.postMessage({ command: "report" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const worker of workers.values()) worker.postMessage({ command: "close" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  workers.clear();

  // Every simulated window is gone. Give the detector a few passes to reap whatever the
  // kills left behind, which is the thing this harness exists to check.
  for (let i = 0; i < 10; i += 1) liveness.tick();
  liveness.stop();

  const totals = [...reports.values()].reduce(
    (accumulator, report) => ({
      reads: accumulator.reads + report.reads,
      inconsistentReads: accumulator.inconsistentReads + report.inconsistentReads,
      staleSnapshots: accumulator.staleSnapshots + report.staleSnapshots,
      corruptions: accumulator.corruptions + report.corruptions,
      attaches: accumulator.attaches + report.attaches,
      slotExhaustions: accumulator.slotExhaustions + report.slotExhaustions,
    }),
    {
      reads: 0,
      inconsistentReads: 0,
      staleSnapshots: 0,
      corruptions: 0,
      attaches: 0,
      slotExhaustions: 0,
    },
  );

  const stats = owner.stats();
  const leakedSlots = owner.readers.claimedSlots();
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const summary = {
    elapsedSeconds,
    windows: windowCount,
    slots,
    events,
    reaped: reaped.length,
    totals,
    leakedSlots,
    finalStats: stats,
  };

  console.log("\nchaos summary\n");
  console.log(`  duration            ${elapsedSeconds.toFixed(1)}s`);
  console.log(`  commits             ${stats.versionId}`);
  console.log(`  reads               ${totals.reads}`);
  console.log(`  windows opened      ${events.opened}`);
  console.log(`  reloaded            ${events.reloaded}`);
  console.log(`  closed              ${events.closed}`);
  console.log(`  killed mid read     ${events.killed}`);
  console.log(`  frozen              ${events.frozen}`);
  console.log(`  slots reaped        ${reaped.length}`);
  console.log(`  slot exhaustions    ${totals.slotExhaustions}`);
  console.log(`  inconsistent reads  ${totals.inconsistentReads}`);
  console.log(`  corruptions         ${totals.corruptions}`);
  console.log(`  stale snapshots     ${totals.staleSnapshots}`);
  console.log(`  claimed slots left  ${leakedSlots.length}`);
  console.log(`  minimum pinned      ${stats.minimumPinnedEpoch}`);
  console.log(`  live bytes          ${stats.liveBytes}`);
  console.log(`  stranded bytes      ${stats.strandedBytes}`);

  if (values.report) {
    await mkdir(dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(summary, null, 2));
    console.log(`\n  report written to ${values.report}`);
  }

  const failures: string[] = [];
  if (totals.inconsistentReads > 0) failures.push(`${totals.inconsistentReads} inconsistent reads`);
  if (totals.corruptions > 0) failures.push(`${totals.corruptions} corrupt decodes`);
  if (leakedSlots.length > 0) failures.push(`${leakedSlots.length} reader slots never released`);
  if (stats.minimumPinnedEpoch !== 0) failures.push("a version is still pinned by nobody");
  if (events.killed === 0) failures.push("no window was killed, so the harness proved nothing");
  if (totals.reads === 0) failures.push("no reads were recorded");

  if (failures.length > 0) {
    console.error(`\ngate: FAIL, ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\ngate: PASS, no leaked slot, no stuck epoch, no incorrect read");
  process.exit(0);
}

console.log(
  `chaos: ${windowCount} windows over ${slots} slots, ${durationSeconds}s\n`,
);
setImmediate(writeBatch);
setTimeout(disturb, 150).unref?.();
setTimeout(() => void finish(), durationSeconds * 1000 + 200);
