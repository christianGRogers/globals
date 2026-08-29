/**
 * The read latency benchmark through the real stack: a real renderer process, the real
 * preload, the real decode, against the real ipcRenderer round trip. The core benchmark in
 * benchmarks/read-latency.ts measures the arena in isolation; this measures what an
 * application actually pays on each side of the contextBridge.
 *
 *   npm run bench:native
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";

import { startNativeOwner } from "../../dist/src/native/owner.js";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    report: { type: "string", default: join(here, "bench-result.json") },
    rows: { type: "string", default: "2000" },
  },
  strict: false,
  allowPositionals: true,
});
const rowCount = Number(values.rows);
const regionPath = join(app.getPath("temp"), `globals-bench-${process.pid}.region`);

async function main() {
  const watchdog = setTimeout(() => {
    console.error("the benchmark timed out");
    app.exit(1);
  }, 120_000);
  watchdog.unref?.();

  const owner = await startNativeOwner({
    regionPath,
    initial: {
      tick: 0,
      rows: Array.from({ length: rowCount }, (_unused, i) => ({
        name: `row number ${i}`,
        value: i * 3,
        flag: (i & 1) === 0,
      })),
    },
    operations: {
      tick(draft) {
        draft.tick += 1;
      },
    },
  });

  // One commit on request, so the preload can measure the read that observes it: the
  // version check that misses, the region copy, and the fresh attach, all on one line.
  ipcMain.handle("bench:commit", () => owner.update((draft) => (draft.tick += 1)));
  ipcMain.handle("bench:echo", (_event, x) => x);

  const reported = new Promise((resolve) => {
    ipcMain.once("bench:report", (_event, report) => resolve(report));
  });

  const window = new BrowserWindow({
    show: false,
    width: 600,
    height: 400,
    webPreferences: {
      preload: join(here, "preload.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--bench-rows=${rowCount}`],
    },
  });
  window.webContents.on("console-message", (_e, _l, message) => {
    console.log(`  [renderer] ${message}`);
  });
  await window.loadFile(join(here, "page.html"));

  const report = await reported;
  clearTimeout(watchdog);

  console.log(
    `\nnative read latency on Electron ${process.versions.electron}, ` +
      `${process.platform} ${process.arch}, ${rowCount} rows\n`,
  );
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("measurement", 44)}${pad("mean", 12)}${pad("p50", 12)}p99`);
  for (const row of report.rows) {
    console.log(
      `  ${pad(row.name, 44)}${pad(row.mean.toFixed(1), 12)}${pad(row.p50.toFixed(1), 12)}${row.p99.toFixed(1)}`,
    );
  }

  await mkdir(dirname(String(values.report)), { recursive: true });
  await writeFile(
    String(values.report),
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        at: new Date().toISOString(),
        rowCount,
        rows: report.rows,
      },
      null,
      2,
    ),
  );
  await unlink(regionPath).catch(() => {});
  owner.close();
  app.exit(0);
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  });
});
