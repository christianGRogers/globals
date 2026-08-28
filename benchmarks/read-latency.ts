/**
 * The kept benchmark.
 *
 * Spike 04 measured a model of the read path. This measures the real one, through the real
 * decoder, and it is the harness behind every performance number in the documentation.
 * Anyone disputing a claim can run it.
 *
 *   npm run bench
 *   node benchmarks/dist/read-latency.js --iterations 4000 --batch 2000
 */
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { cpus, totalmem, platform, release, arch } from "node:os";

import { ArenaOwner, ArenaReader } from "@globals/core";

interface Measurement {
  readonly label: string;
  readonly meanNs: number;
  readonly p50Ns: number;
  readonly p99Ns: number;
}

function stats(samples: number[]): { meanNs: number; p50Ns: number; p99Ns: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] as number;
  return {
    meanNs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ns: at(0.5),
    p99Ns: at(0.99),
  };
}

function timeSync(label: string, iterations: number, batch: number, fn: () => unknown): Measurement {
  for (let i = 0; i < 20_000; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    for (let j = 0; j < batch; j += 1) fn();
    samples.push(Number(process.hrtime.bigint() - start) / batch);
  }
  return { label, ...stats(samples) };
}

async function timeRoundTrip(label: string, iterations: number): Promise<Measurement> {
  const source = `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (message) => parentPort.postMessage(message));
  `;
  const worker = new Worker(source, { eval: true });
  const pending = new Map<number, (value: unknown) => void>();
  worker.on("message", (message: { id: number }) => {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const invoke = (id: number): Promise<unknown> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, value: id });
    });

  for (let i = 0; i < 500; i += 1) await invoke(i);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await invoke(1_000_000 + i);
    samples.push(Number(process.hrtime.bigint() - start));
  }
  await worker.terminate();
  return { label, ...stats(samples) };
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: "string", default: "2000" },
    batch: { type: "string", default: "2000" },
    roundTrips: { type: "string", default: "2000" },
  },
});

const iterations = Number(values.iterations);
const batch = Number(values.batch);
const roundTrips = Number(values.roundTrips);

const owner = ArenaOwner.create({ byteLength: 1 << 20, maxReaders: 4, retainedVersions: 64 });
const reader = ArenaReader.attach(owner.buffer);

owner.commit(1234.5);
const local = { value: 1234.5 };

const results: Measurement[] = [
  timeSync("shared read, double", iterations, batch, () => reader.read()),
  timeSync("shared read, snapshot reuse", iterations, batch, () => reader.acquire().versionId),
  timeSync("plain local property read", iterations, batch, () => local.value),
];

owner.commit("a string of moderate length for a key");
results.push(timeSync("shared read, string", iterations, batch, () => reader.read()));

owner.commit(42);
results.push(timeSync("shared read, int32", iterations, batch, () => reader.read()));

results.push(await timeRoundTrip("structured clone round trip", roundTrips));

const cpu = cpus()[0];
console.log("machine\n");
console.log(`  cpu     ${cpu?.model ?? "unknown"}, ${cpus().length} logical`);
console.log(`  memory  ${(totalmem() / 2 ** 30).toFixed(0)} GB`);
console.log(`  os      ${platform()} ${release()} ${arch()}`);
console.log(`  node    ${process.versions.node}\n`);

console.log("read latency, nanoseconds per operation\n");
console.log("  measurement                        mean       p50       p99");
for (const result of results) {
  console.log(
    `  ${result.label.padEnd(31)} ${result.meanNs.toFixed(1).padStart(9)}` +
      ` ${result.p50Ns.toFixed(1).padStart(9)} ${result.p99Ns.toFixed(1).padStart(9)}`,
  );
}

const sharedDouble = results[0] as Measurement;
const localRead = results[2] as Measurement;
const roundTrip = results[results.length - 1] as Measurement;
const speedup = roundTrip.meanNs / sharedDouble.meanNs;

console.log(`\n  shared read is ${speedup.toFixed(0)} times faster than a round trip`);
console.log(
  `  shared read costs ${(sharedDouble.meanNs / localRead.meanNs).toFixed(1)}` +
    " times a plain local property read",
);
console.log(
  "\nnote: the round trip arm uses a Node worker thread, not an Electron process\n" +
    "boundary. Real ipcRenderer.invoke is slower, so the ratio is a conservative floor.",
);

reader.detach();
