/**
 * The example application.
 *
 * Three windows over one shared state: a table of five thousand rows, an editor that writes
 * to it, and a stats panel that reads the same state without any replication. Plus a fourth
 * window on the asynchronous tier, to show what the trust model opt out actually looks like.
 *
 *   npm install
 *   npm run gate:example
 */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GlobalsHost, prepare, preloadPath } from "../../packages/electron/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// The repository root, because these pages import the packages directly from dist rather
// than through a bundler. A page can only reach what the served root contains, so serving
// examples/multi-window/renderer would give every import a 404 and three blank windows.
//
// A real application bundles its renderer and serves only the bundle. This one is deliberately
// unbundled so the imports show which package each piece comes from.
const repositoryRoot = join(here, "..", "..");

// Registering the scheme is the one thing that has to happen before the app is ready.
prepare();

// Everything after this point runs inside a function rather than at module scope, and that
// is not a style choice. In an ES module main entry, the ready event does not fire until the
// entry module has finished evaluating, so a top level "await app.whenReady()" waits for an
// event that is waiting for it. The process hangs with no error, on every platform.
//
// This cost a wrong diagnosis once already: the hang was read as "no interactive desktop"
// when it was this.
async function main() {

  const host = await GlobalsHost.start({
    root: repositoryRoot,
    ownerPage: "examples/multi-window/renderer/owner.html",
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
    void window.loadURL(host.url(`examples/multi-window/renderer/${page}`));
    return window;
  }

  open({ page: "table.html", name: "table", title: "Table, five thousand rows" });
  open({ page: "editor.html", name: "editor", title: "Editor", width: 520, height: 420 });
  open({ page: "stats.html", name: "stats", title: "Arena", width: 520, height: 520 });

  // A window that renders content this application does not control. It never receives the
  // buffer, so it cannot corrupt shared state, and it pays for that with asynchronous reads.
  open({ page: "untrusted.html", name: "untrusted-plugin", title: "Plugin, async tier", width: 520, height: 360 });

  app.on("window-all-closed", () => app.quit());
}

app.whenReady().then(() => {
  void main();
});
