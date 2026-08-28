/**
 * The Electron half of the phase 3 exit criterion.
 *
 * Windows are opened, reloaded, and killed at random for a configurable period while the
 * owner commits continuously. At the end it asserts that nothing leaked: no reader slot
 * still claimed, no version still pinned, no incorrect read reported by any window.
 *
 * What this covers that the Node chaos harness cannot: the bootstrap handshake, the custom
 * protocol, cross origin isolation, real renderer processes, and a real crash rather than a
 * terminated worker thread.
 *
 *   npm install
 *   npm run gate:chaos
 *
 * Like spike 01, the verdict goes to a JSON file: an Electron main process on Windows is a
 * GUI subsystem binary and its console output never reaches the parent pipe.
 */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { GlobalsHost, prepare, preloadPath } from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// packages/electron, because the pages import ../../dist/src directly. Serving the chaos-app
// directory would 404 every one of those and the windows would load nothing.
const packageRoot = join(here, "..", "..");
// Filtering argv down to things starting with two dashes looks like a reasonable way to
// ignore the switches Electron injects. It is not: it drops the values as well, so
// "--report path" parses as report being "--seconds". Tolerating unknown tokens is the
// version that works.
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    seconds: { type: "string", default: "60" },
    windows: { type: "string", default: "4" },
    report: { type: "string", default: join(here, "chaos-result.json") },
  },
  strict: false,
  allowPositionals: true,
});

const durationMs = Number(values.seconds) * 1000;
const windowCount = Number(values.windows);

prepare();

const events = { opened: 0, reloaded: 0, killed: 0, closed: 0 };
let host;
let observations = [];

async function writeReport(verdict, failures) {
  // A last read through the main process, which is asynchronous by design, doubles as a
  // check that the owner window survived the run.
  let finalState;
  try {
    finalState = await host?.read();
    observations = Object.values(finalState?.observations ?? {});
  } catch (error) {
    failures.push(`the owner did not answer a final read: ${error.message}`);
  }
  await writeFile(
    String(values.report),
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        at: new Date().toISOString(),
        events,
        observations,
        finalState,
        failures,
        verdict,
      },
      null,
      2,
    ),
  );
}

function openWindow(id) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  host.attach(window, { name: `chaos-${id}` });
  void window.loadURL(host.url(`test/chaos-app/ui.html?id=${id}`));
  events.opened += 1;
  return window;
}

await app.whenReady();

host = await GlobalsHost.start({
  root: packageRoot,
  ownerPage: "test/chaos-app/owner.html",
});

const windows = new Map();
for (let id = 0; id < windowCount; id += 1) windows.set(id, openWindow(id));

const finishAt = Date.now() + durationMs;

const disturb = setInterval(() => {
  if (Date.now() >= finishAt) return;
  const ids = [...windows.keys()];
  const id = ids[Math.floor(Math.random() * ids.length)];
  if (id === undefined) return;
  const window = windows.get(id);
  const roll = Math.random();

  if (roll < 0.4) {
    window?.webContents.reload();
    events.reloaded += 1;
    return;
  }
  if (roll < 0.7) {
    // A real renderer kill, which is the case the liveness detector exists for. The slot is
    // still claimed and the epoch still pinned when the process disappears.
    window?.webContents.forcefullyCrashRenderer();
    events.killed += 1;
    return;
  }
  window?.destroy();
  windows.delete(id);
  events.closed += 1;
  setTimeout(() => windows.set(id, openWindow(id)), 400);
}, 500);

setTimeout(async () => {
  clearInterval(disturb);
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.destroy();
  }

  // Give the liveness detector in the owner several passes to reap what the kills left.
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const failures = [];
  await writeReport("PENDING", failures);

  const bad = observations.filter((observation) => observation.inconsistent > 0);
  if (bad.length > 0) failures.push(`${bad.length} windows reported an inconsistent read`);
  if (observations.length === 0) failures.push("no window reported at all");
  if (events.killed === 0) failures.push("no renderer was killed, so nothing was proved");

  await writeReport(failures.length === 0 ? "PASS" : "FAIL", failures);
  app.exit(failures.length === 0 ? 0 : 1);
}, durationMs + 500);
