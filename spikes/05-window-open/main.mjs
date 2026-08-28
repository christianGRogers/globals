/**
 * Spike 05: does a SharedArrayBuffer survive window.open plus postMessage?
 *
 * Spike 01 established that a SharedArrayBuffer posted over a MessageChannelMain port does
 * not deserialise in the receiving renderer, even with both ends cross origin isolated. That
 * is Electron's serializer, not Chromium's.
 *
 * A window opened with window.open is a related browsing context, and a post to it uses
 * Chromium's own window messaging. If a buffer survives that, the topology is implementable
 * with a different handshake rather than not at all, which is the difference between a design
 * change and an off ramp.
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEME = "globals-spike5";
const PRELOAD = join(here, "..", "01-share-buffer", "preload.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const reportPath =
  process.argv.find((a) => a.startsWith("--report="))?.slice("--report=".length) ??
  join(here, "spike05-result.json");

const rendererLog = [];
const reports = [];

function serve() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const segments = decodeURIComponent(pathname)
      .split("/")
      .filter((s) => s.length > 0 && s !== "." && s !== "..");
    const file = normalize(join(here, ...segments));
    if (!file.startsWith(here)) return new Response("forbidden", { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
          "cross-origin-resource-policy": "same-origin",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
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
  const opener = reports.find((r) => r.window === "opener");
  const checks = [
    { name: "window.open was allowed", pass: opener?.blocked !== true },
    { name: "posting the buffer did not throw", pass: opener?.postThrew === undefined },
    { name: "the opened window received the buffer", pass: opener?.childReceived === true },
    { name: "the opened window read the opener's value", pass: opener?.childSawOwnerValue === true },
    { name: "the opener saw the opened window's write", pass: opener?.ownerSawChildWrite === true },
  ];
  const failed = checks.filter((c) => !c.pass);
  void writeReport(checks, failed.length === 0 ? "PASS" : "FAIL").then(() =>
    app.exit(failed.length === 0 ? 0 : 1),
  );
}

ipcMain.on("spike:report", (_event, report) => {
  reports.push(report);
  if (report.window === "opener" && (report.blocked || report.postThrew || "childReceived" in report)) {
    finish();
  }
});

async function main() {
  serve();

  const watchdog = setTimeout(() => {
    void writeReport(
      [{ name: "the spike reached a verdict", pass: false, detail: "timed out" }],
      "FAIL",
    ).then(() => app.exit(1));
  }, 20_000);
  watchdog.unref?.();

  const opener = new BrowserWindow({ show: true, width: 640, height: 420, webPreferences: WEB_PREFERENCES });

  const attach = (contents, label) => {
    contents.on("console-message", (_e, _level, message, line, source) => {
      rendererLog.push(`[${label}] ${message} (${source}:${line})`);
    });
    contents.on("preload-error", (_e, path, error) => {
      rendererLog.push(`[${label}] preload failed: ${path}: ${error.message}`);
    });
  };
  attach(opener.webContents, "opener");

  // Allowing window.open is the whole point. The opened window inherits the same sandboxed,
  // context isolated preferences, so the gate conditions still hold.
  opener.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { show: true, width: 640, height: 420, webPreferences: WEB_PREFERENCES },
  }));

  app.on("browser-window-created", (_event, window) => {
    if (window.webContents !== opener.webContents) attach(window.webContents, "child");
  });

  await opener.loadURL(`${SCHEME}://spike/opener.html`);
}

app.whenReady().then(() => {
  void main();
});
