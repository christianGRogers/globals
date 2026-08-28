/**
 * The end to end test.
 *
 * Real windows, real renderer processes, the real handshake. It proves the thing the library
 * claims: a window reads shared state synchronously, on the line it needs it, and a write
 * from one window is visible to another.
 *
 *   npm run gate:e2e
 */
import { app } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { GlobalsHost, prepare } from "../../dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// The repository root, because the pages import @globals/core through an import map and a
// page can only reach what the served root contains.
const repositoryRoot = join(here, "..", "..", "..", "..");
const PAGES = "packages/electron/test/e2e-app";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { report: { type: "string", default: join(here, "e2e-result.json") } },
  strict: false,
  allowPositionals: true,
});

prepare();

const rendererLog = [];

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
        checks,
        verdict,
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const watchdog = setTimeout(() => {
    void report(
      [{ name: "the test reached a verdict", pass: false, detail: "timed out" }],
      "FAIL",
    ).then(() => app.exit(1));
  }, 40_000);

  let host;
  try {
    host = await GlobalsHost.start({
      root: repositoryRoot,
      ownerPage: `${PAGES}/owner.html`,
      onOwnerMessage: (line) => rendererLog.push(`[owner] ${line}`),
    });

    const windows = ["shared-a", "shared-b", "untrusted-plugin"];
    const processIds = { owner: host.ownerWindow?.webContents.getOSProcessId() };
    for (const name of windows) {
      const window = await host.openWindow({
        page: `${PAGES}/page.html?name=${name}`,
        name,
        browserWindow: { show: false, width: 700, height: 500 },
      });
      processIds[name] = window.webContents.getOSProcessId();
      window.webContents.on("console-message", (_e, _l, message, line, source) => {
        rendererLog.push(`[${name}] ${message} (${source}:${line})`);
      });
    }

    // Give the pages time to run their checks and report through the owner.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // A main process read is asynchronous by design, and this exercises that path too.
    const state = await host.read();
    const observations = state.observations ?? {};
    const a = observations["shared-a"];
    const b = observations["shared-b"];
    const plugin = observations["untrusted-plugin"];

    const checks = [
      { name: "every window reported", pass: Boolean(a && b && plugin) },
      { name: "the owner opened windows on the shared tier", pass: a?.tier === "shared" && b?.tier === "shared" },
      { name: "shared windows are cross origin isolated", pass: a?.crossOriginIsolated === true },
      { name: "a window read shared state synchronously", pass: a?.readSynchronously === true },
      { name: "it saw all five hundred rows", pass: a?.sawRows === true },
      { name: "select reads one path", pass: a?.selectWorks === true },
      { name: "a read on the line after a write returns the old value", pass: a?.readAfterWriteIsStale === true },
      { name: "a read after awaiting the write returns the new value", pass: a?.readAfterAwaitIsFresh === true },
      { name: "a window sees its own write", pass: a?.ownWriteVisible === true && b?.ownWriteVisible === true },
      {
        name: "one window sees the other window's write",
        pass:
          state.rows?.[a?.writtenRow ?? -1]?.value === (a?.writtenRow ?? -1) * 100 &&
          state.rows?.[b?.writtenRow ?? -1]?.value === (b?.writtenRow ?? -1) * 100,
      },
      { name: "the untrusted window is on the async tier", pass: plugin?.tier === "async" },
      { name: "the async tier has no synchronous get", pass: plugin?.hasSynchronousGet === false },
      { name: "the async tier can still read and write", pass: plugin?.asyncReadWorks === true && plugin?.dispatchWorks === true },
      { name: "the main process can read asynchronously", pass: typeof state.counter === "number" },
      {
        // The claim the whole project rests on. If every window is in one renderer process,
        // the buffer was never shared across a process boundary and the result proves nothing
        // that a plain object in one heap would not.
        name: "the owner and a shared window are in different OS processes",
        pass:
          typeof processIds.owner === "number" &&
          typeof processIds["shared-a"] === "number" &&
          processIds.owner !== processIds["shared-a"],
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
    await report(checks, failed.length === 0 ? "PASS" : "FAIL", { observations, processIds });
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
