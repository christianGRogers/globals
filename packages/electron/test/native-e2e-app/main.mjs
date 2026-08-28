/**
 * The end to end test for the native transport.
 *
 * Real windows, real renderer processes, no handshake at all: the owner is a plain object
 * in this process, each window's preload maps the region file itself, and the checks assert
 * the two things the old topology could not deliver together: synchronous shared reads, and
 * windows in different OS processes.
 *
 *   npm run gate:native
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";

import { startNativeOwner } from "../../dist/src/native/owner.js";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { report: { type: "string", default: join(here, "e2e-result.json") } },
  strict: false,
  allowPositionals: true,
});

const regionPath = join(app.getPath("temp"), `globals-native-e2e-${process.pid}.region`);
const rendererLog = [];
const observations = {};
const processIds = { owner: null };

async function report(checks, verdict, extra = {}) {
  await writeFile(
    String(values.report),
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        at: new Date().toISOString(),
        rendererLog,
        observations,
        processIds,
        checks,
        verdict,
        ...extra,
      },
      null,
      2,
    ),
  );
  await unlink(regionPath).catch(() => {});
}

async function main() {
  const watchdog = setTimeout(() => {
    void report(
      [{ name: "the test reached a verdict", pass: false, detail: `timed out, reported: ${Object.keys(observations).join(", ") || "none"}` }],
      "FAIL",
    ).then(() => app.exit(1));
  }, 40_000);

  let owner;
  try {
    owner = await startNativeOwner({
      regionPath,
      initial: {
        counter: 1,
        rows: Array.from({ length: 500 }, () => ({ value: 0 })),
      },
      operations: {
        writeRow(draft, payload) {
          draft.rows[payload.row].value = payload.value;
        },
      },
    });
    processIds.owner = process.pid;

    const reported = new Promise((resolve) => {
      ipcMain.on("e2e:report", (_event, observation) => {
        observations[observation.window] = observation;
        if (Object.keys(observations).length === 2) resolve(undefined);
      });
    });

    for (const name of ["shared-a", "shared-b"]) {
      const window = new BrowserWindow({
        show: false,
        width: 700,
        height: 500,
        webPreferences: {
          preload: join(here, "preload.mjs"),
          // The trade the trust model leads with: windows that map the arena run without
          // the Chromium sandbox. Context isolation stays on and the page has no Node.
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
          additionalArguments: [`--e2e-name=${name}`],
        },
      });
      window.webContents.on("console-message", (_e, _l, message, line, source) => {
        rendererLog.push(`[${name}] ${message} (${source}:${line})`);
      });
      window.webContents.on("preload-error", (_e, path, error) => {
        rendererLog.push(`[${name}] preload failed: ${path}: ${error.message}`);
      });
      await window.loadFile(join(here, "page.html"));
      processIds[name] = window.webContents.getOSProcessId();
    }

    await reported;

    // The owner reads its own store synchronously: main is the owner in this topology.
    const deadline = Date.now() + 5000;
    let mainSawBoth = false;
    while (!mainSawBoth && Date.now() < deadline) {
      mainSawBoth =
        owner.store.select(["rows", 7, "value"]) === 700 &&
        owner.store.select(["rows", 9, "value"]) === 900;
      if (!mainSawBoth) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const a = observations["shared-a"];
    const b = observations["shared-b"];
    const both = (key) => a?.[key] === true && b?.[key] === true;

    const checks = [
      { name: "every window reported", pass: Boolean(a && b) },
      { name: "arena windows run without the sandbox, with context isolation on", pass: both("isolationAsStated") },
      { name: "the region held a commit before the first read", pass: both("regionReady") },
      { name: "a window read shared state synchronously", pass: both("readSynchronously") },
      { name: "it saw all five hundred rows", pass: both("sawRows") },
      { name: "select reads one path", pass: both("selectWorks") },
      { name: "a read on the line after a write returns the old value", pass: both("readAfterWriteIsStale") },
      { name: "a read after awaiting the write returns the new value", pass: both("readAfterAwaitIsFresh") },
      { name: "a window sees its own write", pass: both("ownWriteVisible") },
      { name: "one window sees the other window's write", pass: both("crossWindowRead") },
      { name: "a snapshot pinned across a commit keeps reading its commit", pass: both("snapshotPinned") },
      { name: "a commit notification fired subscribers", pass: both("subscribeFired") },
      { name: "the owner process reads its own store synchronously", pass: mainSawBoth },
      {
        // The claim the topology exists for. If the windows shared a process with the owner
        // or each other, the result would prove nothing a plain object in one heap would not.
        name: "the owner and a shared window are in different OS processes",
        pass:
          typeof processIds["shared-a"] === "number" &&
          processIds["shared-a"] !== processIds.owner,
        detail: JSON.stringify(processIds),
      },
      {
        name: "two shared windows are in different OS processes",
        pass: processIds["shared-a"] !== processIds["shared-b"],
        detail: JSON.stringify(processIds),
      },
    ];

    clearTimeout(watchdog);
    const failed = checks.filter((c) => !c.pass);
    await report(checks, failed.length === 0 ? "PASS" : "FAIL");
    app.exit(failed.length === 0 ? 0 : 1);
  } catch (error) {
    clearTimeout(watchdog);
    await report(
      [{ name: "the test ran", pass: false, detail: `${error.name}: ${error.message}` }],
      "FAIL",
    );
    app.exit(1);
  }
}

app.whenReady().then(() => {
  void main();
});
