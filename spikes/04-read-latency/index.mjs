import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const WORKER = fileURLToPath(new URL("./echo-worker.mjs", import.meta.url));

function stats(samplesNs) {
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
  return { meanNs: mean, p50Ns: at(0.5), p99Ns: at(0.99) };
}

function timeSync(label, iterations, batch, fn) {
  // Warm up so the measurement reflects optimised code rather than the interpreter.
  for (let i = 0; i < 10_000; i += 1) fn(i);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    for (let j = 0; j < batch; j += 1) fn(j);
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / batch);
  }
  return { label, ...stats(samples) };
}

async function timeRoundTrip(label, iterations) {
  const worker = new Worker(WORKER);
  const pending = new Map();
  worker.on("message", (message) => {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.value);
  });

  const invoke = (id, value) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, value });
    });

  for (let i = 0; i < 200; i += 1) await invoke(i, i);

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await invoke(1_000_000 + i, i);
    samples.push(Number(process.hrtime.bigint() - start));
  }
  await worker.terminate();
  return { label, ...stats(samples) };
}

export async function run(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: {
      iterations: { type: "string", default: "2000" },
      batch: { type: "string", default: "1000" },
      roundTrips: { type: "string", default: "2000" },
    },
  });
  const iterations = Number(values.iterations);
  const batch = Number(values.batch);
  const roundTrips = Number(values.roundTrips);

  // A shared read in the real library is: one atomic load of the root, then a bounded
  // walk of tagged slots. This models a three level walk plus the atomic load.
  const sab = new SharedArrayBuffer(4096);
  const i32 = new Int32Array(sab);
  const f64 = new Float64Array(sab);
  i32[0] = 64; // root offset in words
  for (let i = 64; i < 256; i += 1) i32[i] = i * 7;
  f64[64] = 42.5;

  const local = { a: { b: { c: 42.5 } } };

  const results = [
    timeSync("shared memory read", iterations, batch, () => {
      const root = Atomics.load(i32, 0);
      const level1 = i32[root + 1];
      const level2 = i32[(level1 & 63) + 64];
      return f64[(level2 & 7) + 64];
    }),
    timeSync("plain local object read", iterations, batch, () => local.a.b.c),
    await timeRoundTrip("structured clone round trip", roundTrips),
  ];

  const shared = results[0];
  const roundTrip = results[2];
  const speedup = roundTrip.meanNs / shared.meanNs;

  console.log("read latency, nanoseconds per operation\n");
  console.log("  measurement                     mean       p50       p99");
  for (const result of results) {
    console.log(
      `  ${result.label.padEnd(28)} ${result.meanNs.toFixed(1).padStart(9)}` +
        ` ${result.p50Ns.toFixed(1).padStart(9)} ${result.p99Ns.toFixed(1).padStart(9)}`,
    );
  }

  console.log(`\n  shared read is ${speedup.toFixed(0)} times faster than a round trip`);
  console.log(
    `  shared read costs ${(shared.meanNs / results[1].meanNs).toFixed(1)}` +
      " times a plain local property read",
  );

  const pass = speedup >= 50;
  console.log(
    `\ngate: ${pass ? "PASS" : "FAIL"}, threshold is 50 times, measured ${speedup.toFixed(0)}`,
  );
  console.log(
    "\nnote: the round trip arm uses a Node worker thread. Electron ipcRenderer.invoke\n" +
      "crosses a process boundary and is slower, so this is a conservative comparison.",
  );
  return pass ? 0 : 1;
}
