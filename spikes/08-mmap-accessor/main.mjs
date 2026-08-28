/**
 * Spike 08: real OS shared memory through a native addon, with the Chromium sandbox off.
 *
 * Phase 0 established that no web platform mechanism carries a SharedArrayBuffer between
 * renderer processes, because the HTML agent cluster rule forbids it. This spike steps
 * outside the web platform: a file-backed region mapped into the main process and into two
 * renderer processes by an N-API addon, read through native accessor calls so the V8 memory
 * cage never sees a foreign pointer. The price is sandbox: false on the mapping windows,
 * which is the trade the trust model would have to name.
 *
 * Measured: cross process visibility in both directions, seqlock consistency under a writer
 * at full rate, and the read costs that decide whether this carries the library: the raw
 * accessor call, a consistent seqlock record read, the 1MB copy of the refresh hybrid, the
 * contextBridge crossing an application would pay, and the real ipcRenderer.invoke round
 * trip it all competes against.
 *
 * --remap adds the deliberately dangerous arm: MAP_FIXED remapping of the region over an
 * in-cage ArrayBuffer for zero copy TypedArray reads. It runs after the base report is out,
 * so a crash costs the experiment and not the measurement.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const SIZE = 1 << 20;
const TORTURE_MS = 2000;
const REMAP = process.argv.includes("--remap");

const reportPath =
  process.argv.find((a) => a.startsWith("--report="))?.slice("--report=".length) ??
  join(here, "spike08-result.json");
const mapPath = join(tmpdir(), `globals-spike08-${process.pid}.mem`);

let addon;
try {
  addon = require_(join(here, "build", "Release", "spike08.node"));
} catch {
  console.error("the addon is not built. Run: npx node-gyp rebuild --directory spikes/08-mmap-accessor");
  app.exit(2);
}

const rendererLog = [];
const reports = [];
let remapReport = null;
let writerStats = null;
let finished = false;

async function writeReport(checks, verdict) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        remapArm: REMAP,
        at: new Date().toISOString(),
        mainPid: process.pid,
        writerStats,
        rendererLog,
        reports,
        remapReport,
        checks,
        verdict,
      },
      null,
      2,
    ),
  );
  await unlink(mapPath).catch(() => {});
}

function finish() {
  if (finished) return;
  finished = true;
  const pages = reports;
  const pids = new Set(pages.map((p) => p.pid));
  const a = pages.find((p) => p.window === "page-a");
  const speedup =
    a && a.bench ? (a.bench.ipcRoundTripUs * 1000) / a.bench.loadSlotNs : 0;
  const checks = [
    {
      name: "the two pages are in different OS processes, and not the main process",
      pass: pages.length === 2 && pids.size === 2 && !pids.has(process.pid),
      detail: `main ${process.pid}, ${pages.map((p) => `${p.window} ${p.pid}`).join(", ")}`,
    },
    {
      name: "both pages read the owner's value through the mapping",
      pass: pages.length === 2 && pages.every((p) => p.ownerValue === true),
    },
    {
      name: "each page saw the other's write directly through memory",
      pass: pages.length === 2 && pages.every((p) => p.directPeerWrite === true),
    },
    {
      name: "zero torn reads under a writer at full rate",
      pass:
        pages.length === 2 &&
        pages.every((p) => p.torture && p.torture.reads > 0 && p.torture.violations === 0),
      detail: pages
        .map((p) => p.torture && `${p.window}: ${p.torture.reads} reads, ${p.torture.retries} retries, ${p.torture.violations} violations`)
        .join("; "),
    },
    {
      name: "accessor read at least 50 times faster than an IPC round trip",
      pass: speedup >= 50,
      detail: a && a.bench ? `measured ${Math.round(speedup)}x: accessor ${a.bench.loadSlotNs.toFixed(1)} ns vs ipc ${a.bench.ipcRoundTripUs.toFixed(1)} us` : "no bench",
    },
  ];
  if (REMAP) {
    checks.push({
      name: "remap arm: the remapped TypedArray is live shared memory, without a crash",
      pass: remapReport !== null && remapReport.ok === true,
      detail: remapReport
        ? remapReport.error ??
          `read ${remapReport.readNs?.toFixed(2)} ns, live heartbeat ${remapReport.liveHeartbeat}`
        : "the renderer died or never reported",
    });
  }
  const failed = checks.filter((c) => !c.pass);
  void writeReport(checks, failed.length === 0 ? "PASS" : "FAIL").then(() =>
    app.exit(failed.length === 0 ? 0 : 1),
  );
}

ipcMain.handle("spike8:echo", (_e, x) => x);
ipcMain.on("spike8:report", (_e, report) => {
  reports.push(report);
  if (reports.length === 2) {
    if (!REMAP) finish();
    // With the remap arm on, wait for its report or its crash, capped below.
    else setTimeout(finish, 15_000);
  }
});
ipcMain.on("spike8:remap-report", (_e, report) => {
  remapReport = report;
  if (reports.length === 2) finish();
});

const ready = [];
ipcMain.on("spike8:ready", (event, name) => {
  ready.push({ name, sender: event.sender });
  if (ready.length === 2) {
    const worker = new Worker(join(here, "writer-worker.cjs"), {
      workerData: { path: mapPath, size: SIZE, ms: TORTURE_MS + 500 },
    });
    worker.on("message", (m) => {
      writerStats = m;
    });
    for (const r of ready) r.sender.send("spike8:torture", TORTURE_MS);
  }
});

async function main() {
  addon.open(mapPath, SIZE, true);
  addon.storeSlot(0, 0xc0ffee);
  let heartbeat = 0;
  setInterval(() => addon.storeSlot(3, ++heartbeat), 5).unref?.();

  const watchdog = setTimeout(() => {
    void writeReport(
      [{ name: "the spike reached a verdict", pass: false, detail: `timed out, ${reports.length} of 2 pages reported` }],
      "FAIL",
    ).then(() => app.exit(1));
  }, 120_000);
  watchdog.unref?.();

  const makeWindow = (name) =>
    new BrowserWindow({
      show: true,
      width: 640,
      height: 420,
      webPreferences: {
        preload: join(here, "preload.cjs"),
        // The point of the spike. The window that maps the arena runs without the Chromium
        // sandbox; context isolation stays on, and the page still has no Node access.
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [
          `--spike8-name=${name}`,
          `--spike8-map=${mapPath}`,
          ...(REMAP ? ["--spike8-remap"] : []),
        ],
      },
    });

  const a = makeWindow("page-a");
  const b = makeWindow("page-b");

  const attach = (contents, label) => {
    contents.on("console-message", (_e, _level, message, line, source) => {
      rendererLog.push(`[${label}] ${message} (${source}:${line})`);
    });
    contents.on("preload-error", (_e, path, error) => {
      rendererLog.push(`[${label}] preload failed: ${path}: ${error.message}`);
    });
    contents.on("render-process-gone", (_e, details) => {
      rendererLog.push(`[${label}] RENDERER GONE: ${details.reason}`);
      // A crash after both base reports exist is the remap arm failing; record it as such.
      if (reports.length === 2) finish();
    });
  };
  attach(a.webContents, "page-a");
  attach(b.webContents, "page-b");

  await a.loadFile(join(here, "page.html"), { query: { name: "page-a" } });
  await b.loadFile(join(here, "page.html"), { query: { name: "page-b" } });
}

app.whenReady().then(() => {
  void main();
});
