// The shared-tier preload: the decode layer lives here, on the Node side of the bridge,
// because every contextBridge crossing costs about a microsecond. The page gets whole
// operations that cross the bridge once, not per-property reads that cross it hundreds of
// times per render.
import { contextBridge } from "electron";

import { connectNative } from "../../packages/electron/dist/src/native/renderer.js";

const store = await connectNative();

contextBridge.exposeInMainWorld("store", {
  /** One bridge crossing for everything a render needs. */
  view() {
    const snapshot = store.snapshot();
    return {
      version: store.version,
      title: snapshot.get(["title"]),
      commitCount: snapshot.get(["commitCount"]),
      rows: snapshot.toJSON().rows,
    };
  },

  /** One path, one crossing, still synchronous. */
  select(path) {
    return store.select(path);
  },

  dispatch(operation, payload) {
    return store.dispatch(operation, payload);
  },

  onCommit(listener) {
    return store.subscribe(listener);
  },
});
