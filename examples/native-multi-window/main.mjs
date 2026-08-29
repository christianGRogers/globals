/**
 * The example application over the native transport.
 *
 * Three windows, two tiers. The table and the editor run with the sandbox off and read
 * shared state synchronously through their preload; the stats window keeps its sandbox and
 * reads by asking. The owner is this process: no hidden window, no scheme, no handshake.
 *
 *   npm run gate:example
 */
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startNativeOwner, asyncPreloadPath } from "../../packages/electron/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

const ROWS = 200;

async function main() {
  const owner = await startNativeOwner({
    regionPath: join(app.getPath("temp"), `globals-example-${process.pid}.region`),
    initial: {
      title: "the native transport, three windows, two tiers",
      commitCount: 0,
      rows: Array.from({ length: ROWS }, (_unused, i) => ({
        name: `row ${i}`,
        value: Math.round(Math.sin(i / 9) * 500) + 500,
      })),
    },
    operations: {
      setValue(draft, payload) {
        draft.rows[payload.row].value = payload.value;
        draft.commitCount += 1;
      },
      rename(draft, payload) {
        draft.rows[payload.row].name = payload.name;
        draft.commitCount += 1;
      },
    },
  });

  const shared = (page, x) =>
    new BrowserWindow({
      show: true,
      x,
      y: 120,
      width: 520,
      height: 640,
      webPreferences: {
        preload: join(here, "preload.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }).loadFile(join(here, "renderer", page));

  await shared("table.html", 80);
  await shared("editor.html", 620);

  const stats = new BrowserWindow({
    show: true,
    x: 1160,
    y: 120,
    width: 380,
    height: 640,
    webPreferences: {
      preload: asyncPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await stats.loadFile(join(here, "renderer", "stats.html"));

  app.on("window-all-closed", () => {
    owner.close();
    app.quit();
  });
}

app.whenReady().then(() => {
  void main();
});
