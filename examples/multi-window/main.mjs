/**
 * The example application.
 *
 * Four windows over one shared state: a table of five thousand rows, an editor that writes to
 * it, a panel showing what this window can see about the arena, and a fourth window on the
 * asynchronous tier to show what the trust model opt out looks like.
 *
 *   npm install
 *   npm run gate:example
 */
import { app } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GlobalsHost, prepare } from "../../packages/electron/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// The repository root, because these pages import the packages directly from dist rather than
// through a bundler. A page can only reach what the served root contains, so serving
// examples/multi-window/renderer would give every import a 404 and four blank windows.
//
// A real application bundles its renderer and serves only the bundle.
const repositoryRoot = join(here, "..", "..");
const RENDERER = "examples/multi-window/renderer";

prepare();

// The ready event does not fire until this module has finished evaluating, so awaiting it at
// module scope waits for something that is waiting for you. Everything goes in a function.
async function main() {
  const host = await GlobalsHost.start({
    root: repositoryRoot,
    ownerPage: `${RENDERER}/owner.html`,
    persistence: { file: join(app.getPath("userData"), "globals-example.json") },
  });

  // The owner opens these, not the main process, because a SharedArrayBuffer only crosses
  // between an opener and the window it opened. The main process still decides what they
  // look like. See docs/adr/0002-window-open-handshake.md.
  await host.openWindow({
    page: `${RENDERER}/table.html`,
    name: "table",
    browserWindow: { width: 900, height: 640, title: "Table, five thousand rows" },
  });
  await host.openWindow({
    page: `${RENDERER}/editor.html`,
    name: "editor",
    browserWindow: { width: 520, height: 460, title: "Editor" },
  });
  await host.openWindow({
    page: `${RENDERER}/stats.html`,
    name: "stats",
    browserWindow: { width: 520, height: 520, title: "Arena" },
  });

  // A window that renders content this application does not control. The owner recognises the
  // name and never sends it the buffer, so it cannot corrupt shared state.
  await host.openWindow({
    page: `${RENDERER}/untrusted.html`,
    name: "untrusted-plugin",
    browserWindow: { width: 520, height: 380, title: "Plugin, async tier" },
  });

  app.on("window-all-closed", () => app.quit());
}

app.whenReady().then(() => {
  void main();
});
