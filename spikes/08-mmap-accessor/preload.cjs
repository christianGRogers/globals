// Spike 08 preload. sandbox: false, contextIsolation: true. This is the whole point of the
// spike: with the Chromium sandbox off for this window, the preload is a full Node context
// that can load the addon and map the shared region, while the page itself stays isolated.
const { contextBridge, ipcRenderer } = require("electron");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--spike8-${name}=`))?.slice(name.length + 10);
const name = arg("name") ?? "page";
const mapPath = arg("map");
const remapRequested = process.argv.includes("--spike8-remap");
const SIZE = 1 << 20;

const addon = require(join(__dirname, "build", "Release", "spike08.node"));
addon.open(mapPath, SIZE, false);

const log = (line) => console.log(`${name}: ${line}`);

// Slot 0 the owner's constant, slot 3 the owner's heartbeat, slots 1 and 2 the pages'.
const mySlot = name === "page-a" ? 1 : 2;
const peerSlot = name === "page-a" ? 2 : 1;
const myValue = name === "page-a" ? 0xface : 0xbeef;
const peerValue = name === "page-a" ? 0xbeef : 0xface;

// The page runs its own benchmark through the bridge, because every real application call
// crosses it when contextIsolation is on. Its result is part of the report.
let mainWorldBench = null;
contextBridge.exposeInMainWorld("spike8", {
  loadSlot: (i) => addon.loadSlot(i),
  mainWorldDone: (result) => {
    mainWorldBench = result;
  },
});

function pollSlot(slot, want, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (addon.loadSlot(slot) === want) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 10);
  });
}

function bench() {
  const local = { value: 42 };
  let sink = 0;

  let n = 2_000_000;
  let t0 = performance.now();
  for (let i = 0; i < n; i++) sink += local.value;
  const plainNs = ((performance.now() - t0) / n) * 1e6;

  n = 2_000_000;
  t0 = performance.now();
  for (let i = 0; i < n; i++) sink += addon.loadSlot(0);
  const loadSlotNs = ((performance.now() - t0) / n) * 1e6;

  n = 200_000;
  t0 = performance.now();
  for (let i = 0; i < n; i++) sink += addon.readRecord().value;
  const readRecordNs = ((performance.now() - t0) / n) * 1e6;

  const target = new Float64Array(SIZE / 8);
  n = 500;
  t0 = performance.now();
  for (let i = 0; i < n; i++) addon.copyInto(target);
  const copyMbMs = (performance.now() - t0) / n;

  return { plainNs, loadSlotNs, readRecordNs, copyMbMs, sink };
}

async function benchIpc() {
  await ipcRenderer.invoke("spike8:echo", 1);
  const n = 2000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await ipcRenderer.invoke("spike8:echo", i);
  return ((performance.now() - t0) / n) * 1000;
}

function torture(ms) {
  const end = Date.now() + ms;
  let reads = 0;
  let retries = 0;
  let violations = 0;
  while (Date.now() < end) {
    const r = addon.readRecord();
    reads++;
    retries += r.retries;
    if (r.violation) violations++;
  }
  return { reads, retries, violations };
}

// The dangerous arm. Runs only after the base report is safely out, so a crash here
// costs the experiment and not the measurement.
function remap() {
  const result = { attempted: true };
  try {
    // Oversize the buffer so the allocation is comfortably page-backed and one page of
    // slack exists for alignment. The reference is stashed on globalThis deliberately:
    // the remapped pages must never be freed.
    const backing = new ArrayBuffer(SIZE + 65536);
    globalThis.__spike8RemappedBacking = backing;
    const info = addon.remapOver(new Uint8Array(backing));
    const i32 = new Int32Array(backing, info.byteOffset, info.byteLength / 4);
    result.mapped = info.byteLength;
    result.ownerValue = i32[2] === 0xc0ffee;

    const hb1 = i32[5];
    const spinUntil = Date.now() + 500;
    while (Date.now() < spinUntil && i32[5] === hb1) {
      /* wait for the owner's heartbeat to move */
    }
    result.liveHeartbeat = i32[5] !== hb1;

    let sink = 0;
    const n = 20_000_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) sink += i32[2];
    result.readNs = ((performance.now() - t0) / n) * 1e6;
    result.sink = sink;
    result.ok = result.ownerValue && result.liveHeartbeat;
  } catch (error) {
    result.ok = false;
    result.error = `${error.name}: ${error.message}`;
  }
  return result;
}

(async () => {
  const report = { window: name, pid: addon.pid(), sandboxed: process.sandboxed === true };
  log(`pid=${addon.pid()}, chromium sandbox=${process.sandboxed === true}`);

  report.ownerValue = addon.loadSlot(0) === 0xc0ffee;
  addon.storeSlot(mySlot, myValue);
  report.directPeerWrite = await pollSlot(peerSlot, peerValue, 15_000);
  log(`owner value seen: ${report.ownerValue}, peer write seen directly: ${report.directPeerWrite}`);

  report.bench = bench();
  report.bench.ipcRoundTripUs = await benchIpc();
  log(
    `plain ${report.bench.plainNs.toFixed(1)} ns, accessor ${report.bench.loadSlotNs.toFixed(1)} ns, ` +
      `seqlock record ${report.bench.readRecordNs.toFixed(1)} ns, copy 1MB ${report.bench.copyMbMs.toFixed(3)} ms, ` +
      `ipc round trip ${report.bench.ipcRoundTripUs.toFixed(1)} us`,
  );

  ipcRenderer.send("spike8:ready", name);
  const tortureMs = await new Promise((resolve) =>
    ipcRenderer.once("spike8:torture", (_e, ms) => resolve(ms)),
  );
  report.torture = torture(tortureMs);
  log(
    `torture: ${report.torture.reads} reads, ${report.torture.retries} retries, ` +
      `${report.torture.violations} violations`,
  );

  report.mainWorldBench = mainWorldBench;
  ipcRenderer.send("spike8:report", report);

  if (remapRequested && name === "page-b") {
    const r = remap();
    log(`remap: ${JSON.stringify(r)}`);
    ipcRenderer.send("spike8:remap-report", r);
  }
})();
