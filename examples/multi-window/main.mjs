/**
 * The example application.
 *
 * Three windows over one shared state: a table of five thousand rows, an editor that writes
 * to it, and a stats panel that reads the same state without any replication. Plus a fourth
 * window on the asynchronous tier, to show what the trust model opt out actually looks like.
 *
 *   npm install --no-save electron@^33
 *   npx electron examples/multi-window/main.mjs
 */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GlobalsHost, prepare, preloadPath } from "../../packages/electron/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// Registering the scheme is the one thing that has to happen before the app is ready.
prepare();

await app.whenReady();

const host = await GlobalsHost.start({
  root: join(here, "renderer"),
  ownerPage: "owner.html",
  persistence: { file: join(app.getPath("userData"), "globals-example.json") },
});

function open({ page, name, title, width = 900, height = 640 }) {
  const window = new BrowserWindow({
    width,
    height,
    title,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  host.attach(window, { name });
  void window.loadURL(host.url(page));
  return window;
}

open({ page: "table.html", name: "table", title: "Table, five thousand rows" });
open({ page: "editor.html", name: "editor", title: "Editor", width: 520, height: 420 });
open({ page: "stats.html", name: "stats", title: "Arena", width: 520, height: 520 });

// A window that renders content this application does not control. It never receives the
// buffer, so it cannot corrupt shared state, and it pays for that with asynchronous reads.
open({ page: "untrusted.html", name: "untrusted-plugin", title: "Plugin, async tier", width: 520, height: 360 });

app.on("window-all-closed", () => app.quit());
