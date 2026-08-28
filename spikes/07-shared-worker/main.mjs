/**
 * Spike 07: can a SharedWorker own the buffer and hand it to every window?
 *
 * A SharedWorker is one instance shared by every same origin context, which is exactly the
 * single writer the design needs, and its ports are created by Chromium rather than by
 * Electron's serializer. If a buffer survives this route, the topology is implementable with
 * a different handshake rather than not at all.
 *
 * The first run of this spike never connected over the custom protocol and surfaced no
 * error, so the transport is now a variable rather than an assumption:
 *
 *   --transport=scheme        the original: custom protocol, minimal privileges (default)
 *   --transport=scheme-full   custom protocol with every privilege the API offers
 *   --transport=http          a real HTTP server on 127.0.0.1 with the same headers
 *
 * Two checks exist because of how spike 05 went wrong. The pages report their OS process
 * ids, and each page must see the other's write directly through its own mapping of the
 * buffer, not through a message. A verdict that does not measure process separation can be
 * passed by a topology that does not have it.
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEME = "globals-spike7";
const PRELOAD = join(here, "..", "01-share-buffer", "preload.cjs");

const TRANSPORT =
  process.argv.find((a) => a.startsWith("--transport="))?.slice("--transport=".length) ??
  "scheme";

// Registration happens before ready and cannot be changed afterwards, so the privilege set
// is chosen here. The full set is everything registerSchemesAsPrivileged accepts, to rule
// out a missing privilege as the reason the worker never connects.
const PRIVILEGES =
  TRANSPORT === "scheme-full"
    ? {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: true,
        stream: true,
        bypassCSP: true,
        codeCache: true,
      }
    : { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };

if (TRANSPORT !== "http") {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: PRIVILEGES }]);
}

// The measured blocker is the SharedWorker scope not being cross origin isolated, which
// hides the SharedArrayBuffer constructor there and makes the transfer to it a
// messageerror. Chromium has a feature that exposes the constructor without isolation,
// and an Electron app can turn it on. Whether it also lets the buffer cross is a
// measurement, not an inference.
const SAB_FLAG = process.argv.includes("--sab-flag");
if (SAB_FLAG) app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

// With the flag on, isolation is not what exposes the constructor, so the headers can be
// withheld to put the pages and the worker in the same non-isolated mode. This measures
// whether the transfer is gated on isolation agreement or refused for shared workers
// altogether.
const NO_ISOLATION = process.argv.includes("--no-isolation");

const reportPath =
  process.argv.find((a) => a.startsWith("--report="))?.slice("--report=".length) ??
  join(here, "spike07-result.json");

const rendererLog = [];
const reports = [];

const ISOLATION_HEADERS = NO_ISOLATION
  ? {}
  : {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    };

function contentType(file) {
  return extname(file) === ".js"
    ? "text/javascript; charset=utf-8"
    : "text/html; charset=utf-8";
}

function resolveFile(pathname) {
  const segments = decodeURIComponent(pathname)
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  const file = normalize(join(here, ...segments));
  return file.startsWith(here) ? file : null;
}

/** Serves the spike files over the chosen transport and returns the base URL. */
async function serve() {
  if (TRANSPORT === "http") {
    const server = createServer(async (request, response) => {
      rendererLog.push(`[server] ${request.method} ${request.url}`);
      const file = resolveFile(new URL(request.url, "http://spike").pathname);
      try {
        if (!file) throw new Error("forbidden");
        const body = await readFile(file);
        response.writeHead(200, { "content-type": contentType(file), ...ISOLATION_HEADERS });
        response.end(body);
      } catch {
        response.writeHead(404).end("not found");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}/`;
  }

  protocol.handle(SCHEME, async (request) => {
    rendererLog.push(`[server] ${request.method} ${request.url}`);
    const file = resolveFile(new URL(request.url).pathname);
    if (!file) return new Response("forbidden", { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: { "content-type": contentType(file), ...ISOLATION_HEADERS },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  return `${SCHEME}://spike/`;
}

const WEB_PREFERENCES = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
};

async function writeReport(checks, verdict) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        transport: TRANSPORT,
        sabFlag: SAB_FLAG,
        noIsolation: NO_ISOLATION,
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
}

function finish() {
  const pages = reports.filter((r) => r.window.startsWith("page-"));
  const pids = new Set(pages.map((p) => p.pid));
  const checks = [
    { name: "SharedWorker is available", pass: pages.every((p) => p.sharedWorkerAvailable === true) },
    { name: "the worker could post the buffer", pass: pages.every((p) => p.postThrew === undefined) },
    { name: "both windows received it", pass: pages.length === 2 && pages.every((p) => p.received === true) },
    { name: "both read the value the worker wrote", pass: pages.every((p) => p.sawOwnerValue === true) },
    { name: "the worker saw a window write to it", pass: pages.some((p) => p.workerSawOurWrite === true) },
    {
      name: "each page saw the other's write directly through memory",
      pass: pages.length === 2 && pages.every((p) => p.directPeerWrite === true),
    },
    {
      name: "the two pages are in different OS processes",
      pass: pages.length === 2 && pids.size === 2,
      detail: `pids: ${pages.map((p) => `${p.window} ${p.pid}`).join(", ")}`,
    },
  ];
  const failed = checks.filter((c) => !c.pass);
  void writeReport(checks, failed.length === 0 ? "PASS" : "FAIL").then(() =>
    app.exit(failed.length === 0 ? 0 : 1),
  );
}

ipcMain.on("spike:report", (event, report) => {
  reports.push({ ...report, pid: event.sender.getOSProcessId() });
  if (reports.filter((r) => r.window.startsWith("page-")).length === 2) finish();
});

async function main() {
  const base = await serve();

  const watchdog = setTimeout(() => {
    void writeReport(
      [{ name: "the spike reached a verdict", pass: false, detail: `timed out, ${reports.length} of 2 pages reported` }],
      "FAIL",
    ).then(() => app.exit(1));
  }, 30_000);
  watchdog.unref?.();

  const opener = new BrowserWindow({ show: true, width: 640, height: 420, webPreferences: WEB_PREFERENCES });
  const reader = new BrowserWindow({ show: true, width: 640, height: 420, webPreferences: WEB_PREFERENCES });

  const attach = (contents, label) => {
    contents.on("console-message", (_e, _level, message, line, source) => {
      rendererLog.push(`[${label}] ${message} (${source}:${line})`);
    });
    contents.on("preload-error", (_e, path, error) => {
      rendererLog.push(`[${label}] preload failed: ${path}: ${error.message}`);
    });
  };
  attach(opener.webContents, "page-a");
  attach(reader.webContents, "page-b");

  // No opener relationship, no ports. Two ordinary windows the main process created, which
  // is what makes this worth testing: if it works, the handshake needs no brokering at all.
  await opener.loadURL(`${base}page.html?name=page-a`);
  await reader.loadURL(`${base}page.html?name=page-b`);
}

app.whenReady().then(() => {
  void main();
});
