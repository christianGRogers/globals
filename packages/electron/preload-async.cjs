// The asynchronous tier's preload, for windows that keep their sandbox.
//
// A sandboxed preload is CommonJS with a require that reaches only "electron", so this file
// is self contained and the channel names are literals; src/native/channel.ts is the other
// copy, and the comment there points back here. Nothing in this file maps the region or
// loads native code: a sandboxed window reads by asking the owner, which is the documented
// trade for keeping the Chromium sandbox.
//
// What the page gets is deliberately small and visibly asynchronous. There is no get() at
// all: a synchronous read does not exist on this tier, and an API that pretended otherwise
// would be the exact confusion the type system elsewhere works to prevent.
const { contextBridge, ipcRenderer } = require("electron");

const HELLO = "globals:native:hello";
const DISPATCH = "globals:native:dispatch";
const COMMIT = "globals:native:commit";
const READ = "globals:native:read";

// Subscribing early means the first commit ping can arrive before the page even asks.
const hello = ipcRenderer.invoke(HELLO);

const listeners = new Set();
ipcRenderer.on(COMMIT, (_event, version) => {
  for (const listener of listeners) {
    try {
      listener(version);
    } catch {
      // A throwing page listener must not take the bridge down.
    }
  }
});

contextBridge.exposeInMainWorld("globalsAsync", {
  tier: "async",

  /** Resolves with { version, value }: the whole state, or one path of it. */
  read(path) {
    return ipcRenderer.invoke(READ, path === undefined ? undefined : { path });
  },

  /** Ask the owner to apply a named operation. Resolves with the committed version. */
  dispatch(operation, payload) {
    return ipcRenderer.invoke(DISPATCH, { operation, payload });
  },

  /** Called with the new version after every commit. Returns an unsubscribe function. */
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Resolves once the connection to the owner exists. */
  ready() {
    return hello.then((h) => h.version);
  },
});
