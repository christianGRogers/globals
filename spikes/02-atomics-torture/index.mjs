import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const PAYLOAD_WORDS = 64;

function spawn(sab, role, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { role, sab, payloadWords: PAYLOAD_WORDS, seconds: 0, increments: 0, ...options },
    });
    let result;
    worker.on("message", (message) => {
      result = message;
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`${role} exited with code ${code}`));
      else resolve(result);
    });
  });
}

async function contendedCounter({ workers, increments }) {
  const sab = new SharedArrayBuffer(1024);
  const i32 = new Int32Array(sab);
  await Promise.all(
    Array.from({ length: workers }, () => spawn(sab, "contended-increment", { increments })),
  );
  const expected = workers * increments;
  const actual = Atomics.load(i32, 0);
  return {
    name: "contended counter",
    expected,
    actual,
    lostUpdates: expected - actual,
    pass: expected === actual,
  };
}

async function messagePassing({ readers, seconds }) {
  const sab = new SharedArrayBuffer(1024);
  const results = await Promise.all([
    spawn(sab, "mp-writer", { seconds }),
    ...Array.from({ length: readers }, () => spawn(sab, "mp-reader", {})),
  ]);
  const readerResults = results.filter((r) => r.role === "mp-reader");
  const reads = readerResults.reduce((sum, r) => sum + r.reads, 0);
  const violations = readerResults.reduce((sum, r) => sum + r.violations, 0);
  return {
    name: "message passing ordering",
    generations: results[0].generations,
    reads,
    violations,
    pass: violations === 0 && reads > 0,
  };
}

async function seqlock({ readers, seconds }) {
  const sab = new SharedArrayBuffer(1024);
  const results = await Promise.all([
    spawn(sab, "seqlock-writer", { seconds }),
    ...Array.from({ length: readers }, () => spawn(sab, "seqlock-reader", {})),
  ]);
  const readerResults = results.filter((r) => r.role === "seqlock-reader");
  const reads = readerResults.reduce((sum, r) => sum + r.reads, 0);
  const retries = readerResults.reduce((sum, r) => sum + r.retries, 0);
  const violations = readerResults.reduce((sum, r) => sum + r.violations, 0);
  return {
    name: "seqlock under a writer at full rate",
    versions: results[0].versions,
    reads,
    retries,
    retryRate: reads + retries === 0 ? 0 : retries / (reads + retries),
    violations,
    pass: violations === 0 && reads > 0,
  };
}

export async function run(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workers: { type: "string", default: "4" },
      readers: { type: "string", default: "3" },
      seconds: { type: "string", default: "5" },
      increments: { type: "string", default: "100000" },
    },
  });
  const workers = Number(values.workers);
  const readers = Number(values.readers);
  const seconds = Number(values.seconds);
  const increments = Number(values.increments);

  const checks = [
    await contendedCounter({ workers, increments }),
    await messagePassing({ readers, seconds }),
    await seqlock({ readers, seconds }),
  ];

  for (const check of checks) {
    const { name, pass, ...rest } = check;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    for (const [key, value] of Object.entries(rest)) {
      const printed = typeof value === "number" && !Number.isInteger(value)
        ? value.toFixed(6)
        : value;
      console.log(`        ${key}: ${printed}`);
    }
  }

  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    console.error(`\ngate: FAIL, ${failed.length} check(s) failed`);
    return 1;
  }
  console.log("\ngate: PASS, atomics behave as the protocol assumes");
  return 0;
}
