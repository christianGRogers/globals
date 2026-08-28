/**
 * The preload bridge.
 *
 * Plain CommonJS on purpose. A sandboxed preload cannot be an ES module and cannot require
 * anything outside the small Electron subset, so this file is written by hand and shipped as
 * it is rather than compiled.
 *
 * It bridges exactly two things: the port that arrives from the main process, and the two
 * bootstrap signals that go back. It exposes no filesystem access, no IPC send of arbitrary
 * channels, and no way for renderer code to reach the main process directly.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = {
  Port: "globals:port",
  Ready: "globals:ready",
  Rebind: "globals:rebind",
  MainIntent: "globals:main-intent",
  MainReply: "globals:main-reply",
  MainRead: "globals:main-read",
};

const portListeners = [];
const mainListeners = [];

ipcRenderer.on(CHANNEL.Port, (event, payload) => {
  const port = event.ports[0];
  if (!port) return;
  for (const listener of portListeners) listener(port, payload);
});

for (const channel of [CHANNEL.MainIntent, CHANNEL.MainRead]) {
  ipcRenderer.on(channel, (_event, request) => {
    for (const listener of mainListeners) listener(channel, request);
  });
}

contextBridge.exposeInMainWorld("__globals", {
  /** Register for the port handoff. Called once by the renderer runtime. */
  onPort(listener) {
    portListeners.push(listener);
    return () => {
      const index = portListeners.indexOf(listener);
      if (index !== -1) portListeners.splice(index, 1);
    };
  },

  /** Tell the main process this window is ready for its port. */
  ready() {
    ipcRenderer.send(CHANNEL.Ready);
  },

  /** Ask for a fresh port after a reload discarded the old one. */
  rebind() {
    ipcRenderer.send(CHANNEL.Rebind);
  },

  /** Owner window only. Requests the main process sends on its own behalf. */
  onMainRequest(listener) {
    mainListeners.push(listener);
  },

  /** Owner window only. The reply to a main process request. */
  replyToMain(reply) {
    ipcRenderer.send(CHANNEL.MainReply, reply);
  },

  channels: CHANNEL,

  /**
   * The gate conditions, asserted by the renderer rather than trusted from configuration.
   * A window that reports these as false is misconfigured, and the runtime says so instead
   * of failing later with a transfer error nobody can trace.
   */
  environment: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
  },
});
