/**
 * Spike 01: does one SharedArrayBuffer reach two sandboxed renderers?
 *
 * The main process is a broker only. It creates MessageChannelMain pairs and hands one
 * port to the owner window and one to each UI window. The buffer itself travels renderer
 * to renderer over those ports and never passes through Node, which is the whole point of
 * the topology.
 */
import { app, BrowserWindow, MessageChannelMain, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEME = "globals-spike";
const PRELOAD = join(here, "preload.cjs");

// A privileged scheme is required for crossOriginIsolated. Registering it must happen
// before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const segments = decodeURIComponent(pathname)
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".");
    const file = normalize(join(here, ...segments)) || join(here, "index.html");
    if (!file.startsWith(here)) return new Response("forbidden", { status: 403 });

    let body;
    try {
      body = await readFile(file);
    } catch {
      return new Response("not found", { status: 404 });
    }
    const extension = file.slice(file.lastIndexOf("."));
    return new Response(body, {
      headers: {
        "content-type": MIME[extension] ?? "application/octet-stream",
        // These two headers are what make crossOriginIsolated true, which is what makes
        // SharedArrayBuffer transferable between renderers.
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  });
}

const loadFailures = [];
const rendererLog = [];

function createWindow({ page, show, title }) {
  const window = new BrowserWindow({
    show,
    width: 640,
    height: 420,
    title,
    webPreferences: {
      preload: PRELOAD,
      // The gate. If the spike only passes with either of these off, the project stops.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The listeners go on before loadURL, not after. Attaching them afterwards is a race: a
  // load that finishes first never resolves the promise, the spike hangs, and the watchdog
  // reports a gate failure that says nothing about whether the buffer can be shared. A
  // spurious failure on a go or no go decision is worse than no result.
  // A renderer that throws is silent from out here, and a spike that cannot say why it saw
  // nothing is not much of a diagnostic. Console output and preload failures are captured
  // into the report.
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    rendererLog.push(`[${title}] ${message} (${source}:${line})`);
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    rendererLog.push(`[${title}] preload failed: ${preloadPath}: ${error.message}`);
  });

  const loaded = new Promise((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (_event, code, description, url) => {
      loadFailures.push(`${title} failed to load ${url}: ${description} (${code})`);
      resolve();
    });
  });

  void window.loadURL(`${SCHEME}://spike/${page}`);
  return { window, loaded };
}

const reports = [];
let expectedReports = 0;

ipcMain.on("spike:report", (_event, report) => {
  reports.push(report);
  console.log(`  ${report.window.padEnd(8)} ${JSON.stringify(report)}`);
  if (reports.length < expectedReports) return;
  clearTimeout(watchdog);
  finish();
});

// On Windows an Electron main process is a GUI subsystem binary, so its console output does
// not reach the parent pipe. The verdict is written to a file and the runner prints it, which
// behaves the same on every platform and in continuous integration.
const reportPath =
  process.argv.find((argument) => argument.startsWith("--report="))?.slice("--report=".length) ??
  join(here, "spike01-result.json");

async function writeReport(checks, verdict) {
  try {
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          platform: process.platform,
          arch: process.arch,
          at: new Date().toISOString(),
          rendererLog,
          reports,
          checks,
          verdict,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`could not write the spike report: ${error.message}`);
  }
}

function finish() {
  const owner = reports.find((r) => r.window === "owner");
  const readers = reports.filter((r) => r.window !== "owner");

  const checks = [
    { name: "crossOriginIsolated in every window", pass: reports.every((r) => r.crossOriginIsolated) },
    { name: "sandbox and contextIsolation stayed on", pass: reports.every((r) => r.sandboxed) },
    { name: "every reader received the buffer", pass: readers.length > 0 && readers.every((r) => r.received) },
    { name: "readers observed the owner write", pass: readers.every((r) => r.sawOwnerValue) },
    { name: "owner observed a reader write", pass: owner?.sawReaderValue === true },
    { name: "grow() was observed by readers", pass: readers.every((r) => r.observedGrowth) },
  ];

  console.log("");
  for (const check of checks) {
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  console.log(
    failed.length === 0
      ? "\ngate: PASS, the topology is implementable on this Electron version"
      : `\ngate: FAIL, ${failed.length} check(s) failed, see docs/plan.md off ramps`,
  );
  void writeReport(checks, failed.length === 0 ? "PASS" : "FAIL").then(() =>
    app.exit(failed.length === 0 ? 0 : 1),
  );
}

// Everything after this point runs inside a function rather than at module scope, and that
// is not a style choice. In an ES module main entry, the ready event does not fire until the
// entry module has finished evaluating, so a top level "await app.whenReady()" waits for an
// event that is waiting for it. The process hangs with no error, on every platform.
//
// This cost a wrong diagnosis once already: the hang was read as "no interactive desktop"
// when it was this.
async function main() {
  serve();

  // The watchdog is armed before anything can block, because the failure this spike most
  // needs to report is a window that never finishes loading. Arming it after the load would
  // mean that failure produces no verdict at all, which is what happened the first time.
  const watchdog = setTimeout(() => {
    const detail =
      loadFailures.length > 0
        ? loadFailures.join("; ")
        : `${reports.length} of ${expectedReports || 3} windows reported`;
    console.error(`\ngate: FAIL, timed out. ${detail}`);
    void writeReport([{ name: "every window loaded and reported", pass: false, detail }], "FAIL").then(
      () => app.exit(1),
    );
  }, 20_000);

  const owner = createWindow({ page: "owner.html", show: false, title: "owner" });
  const readers = [
    createWindow({ page: "ui.html?name=ui-a", show: true, title: "ui-a" }),
    createWindow({ page: "ui.html?name=ui-b", show: true, title: "ui-b" }),
  ];
  const readerWindows = readers.map((entry) => entry.window);
  expectedReports = 1 + readers.length;

  await Promise.all([owner, ...readers].map((entry) => entry.loaded));

  if (loadFailures.length > 0) {
    clearTimeout(watchdog);
    console.error(`\ngate: FAIL, ${loadFailures.join("; ")}`);
    void writeReport(
      loadFailures.map((detail) => ({ name: "window loaded", pass: false, detail })),
      "FAIL",
    ).then(() => app.exit(1));
  } else {
    // One port pair per reader. The owner keeps one end of each.
    for (const reader of readerWindows) {
      const { port1, port2 } = new MessageChannelMain();
      owner.window.webContents.postMessage("spike:port", { peer: reader.getTitle() }, [port1]);
      reader.webContents.postMessage("spike:port", { peer: "owner" }, [port2]);
    }
  }

  console.log(`spike 01, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}\n`);
}

app.whenReady().then(() => {
  void main();
});
