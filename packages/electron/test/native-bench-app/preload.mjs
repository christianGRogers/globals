// The measuring side. Everything here is the real path an application uses: the same
// connectNative, the same decode, the same bridge. Nanoseconds per operation throughout.
import { ipcRenderer, contextBridge } from "electron";
import { performance } from "node:perf_hooks";

import { connectNative } from "../../dist/src/native/renderer.js";

const rowCount = Number(
  process.argv.find((a) => a.startsWith("--bench-rows="))?.slice("--bench-rows=".length) ?? 2000,
);

function stats(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { name, mean, p50: at(0.5), p99: at(0.99) };
}

/** Time a call in batches so timer resolution stays out of the numbers. */
function timed(name, batches, batchSize, run) {
  const samples = [];
  for (let batch = 0; batch < batches; batch++) {
    const t0 = performance.now();
    for (let i = 0; i < batchSize; i++) run(i);
    samples.push(((performance.now() - t0) / batchSize) * 1e6);
  }
  return stats(name, samples);
}

let mainWorld = null;
contextBridge.exposeInMainWorld("bench", {
  select: (path) => storeRef.select(path),
  done: (result) => {
    mainWorld = result;
  },
});
let storeRef;

async function run() {
  const store = await connectNative();
  storeRef = store;
  const rows = [];
  let sink = 0;

  const local = { rows: Array.from({ length: rowCount }, (_u, i) => ({ value: i * 3 })) };
  rows.push(
    timed("plain local property read", 40, 50_000, (i) => {
      sink += local.rows[i % rowCount].value;
    }),
  );

  rows.push(
    timed("select, double, same version", 40, 20_000, (i) => {
      sink += store.select(["rows", i % rowCount, "value"]);
    }),
  );
  rows.push(
    timed("select, string, same version", 40, 10_000, (i) => {
      sink += store.select(["rows", i % rowCount, "name"]).length;
    }),
  );
  rows.push(
    timed("snapshot acquire, no decode", 40, 20_000, () => {
      sink += store.snapshot() === null ? 1 : 0;
    }),
  );

  // The read that observes a fresh commit: version check misses, the region is copied, a
  // fresh reader attaches, and one path decodes. Sequential awaits keep one commit per
  // sample, so this is the whole cost of noticing a change, in microseconds not nanoseconds.
  {
    const samples = [];
    for (let i = 0; i < 400; i++) {
      await ipcRenderer.invoke("bench:commit");
      const t0 = performance.now();
      sink += store.select(["rows", i % rowCount, "value"]);
      samples.push((performance.now() - t0) * 1e6);
    }
    rows.push(stats("select observing a fresh commit (sync + attach)", samples));
  }

  // What the page pays: the same select, across the contextBridge.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (mainWorld !== null) {
        clearInterval(poll);
        resolve(undefined);
      }
    }, 25);
  });
  rows.push(mainWorld);

  {
    const samples = [];
    for (let i = 0; i < 1500; i++) {
      const t0 = performance.now();
      await ipcRenderer.invoke("bench:echo", i);
      samples.push((performance.now() - t0) * 1e6);
    }
    rows.push(stats("ipcRenderer.invoke round trip", samples));
  }

  console.log(`sink ${sink}`);
  ipcRenderer.send("bench:report", { rows });
}

void run();
