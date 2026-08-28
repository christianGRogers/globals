// The whole test lives in the preload, because the preload is the Node context the native
// transport runs in. The page stays inert; what an application would expose to it through
// contextBridge is its own design, measured separately (the bridge costs about a
// microsecond per crossing).
import { ipcRenderer } from "electron";

import { connectNative } from "../../dist/src/native/renderer.js";

const name =
  process.argv.find((a) => a.startsWith("--e2e-name="))?.slice("--e2e-name=".length) ?? "page";
const log = (line) => console.log(`${name}: ${line}`);

const myRow = name === "shared-a" ? 7 : 9;
const peerRow = name === "shared-a" ? 9 : 7;

async function run() {
  const observation = {
    window: name,
    // process.sandboxed is undefined, not false, in an unsandboxed preload.
    isolationAsStated: process.sandboxed !== true && process.contextIsolated === true,
  };
  try {
    const store = await connectNative();
    observation.regionReady = store.version >= 1;

    observation.readSynchronously = typeof store.select(["counter"]) === "number";
    const rows = store.snapshot().toJSON().rows;
    observation.sawRows = Array.isArray(rows) && rows.length === 500 && rows[499].value === 0;
    observation.selectWorks = store.select(["rows", 3, "value"]) === 0;

    let pings = 0;
    const unsubscribe = store.subscribe(() => pings++);

    const pinned = store.snapshot();
    const write = store.dispatch("writeRow", { row: myRow, value: myRow * 100 });
    observation.readAfterWriteIsStale = store.select(["rows", myRow, "value"]) === 0;
    await write;
    observation.readAfterAwaitIsFresh = store.select(["rows", myRow, "value"]) === myRow * 100;
    observation.ownWriteVisible = observation.readAfterAwaitIsFresh;
    observation.snapshotPinned = pinned.get(["rows", myRow, "value"]) === 0;

    const deadline = Date.now() + 8000;
    let crossWindowRead = false;
    while (!crossWindowRead && Date.now() < deadline) {
      crossWindowRead = store.select(["rows", peerRow, "value"]) === peerRow * 100;
      if (!crossWindowRead) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    observation.crossWindowRead = crossWindowRead;

    // The ping rides its own IPC channel and may land after the dispatch reply, so give it
    // a moment. What matters is that it arrives and only drives rerenders, not when.
    const pingDeadline = Date.now() + 3000;
    while (pings === 0 && Date.now() < pingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    observation.subscribeFired = pings > 0;
    unsubscribe();
  } catch (error) {
    observation.error = `${error.name}: ${error.message}`;
    log(`FAILED: ${observation.error}`);
  }
  ipcRenderer.send("e2e:report", observation);
}

void run();
