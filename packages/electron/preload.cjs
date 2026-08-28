/**
 * The owner window's preload bridge.
 *
 * Plain CommonJS on purpose: a sandboxed preload cannot be an ES module.
 *
 * Only the owner window needs this. A UI window talks to the owner through its opener, in
 * its own world, with no preload involved. That is not a shortcut: a MessagePort cannot cross
 * contextBridge, so a design that tried to hand ports to pages could not work. See ADR 0002.
 *
 * What crosses here is only what the main process and the owner have to say to each other:
 * open a window, read state, apply a write. The buffer never crosses it.
 */
const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = {
  OpenWindow: "globals:open-window",
  OpenResult: "globals:open-result",
  MainRead: "globals:main-read",
  MainIntent: "globals:main-intent",
  MainReply: "globals:main-reply",
};

const listeners = [];

for (const channel of [CHANNEL.OpenWindow, CHANNEL.MainRead, CHANNEL.MainIntent]) {
  ipcRenderer.on(channel, (_event, request) => {
    for (const listener of listeners) listener(channel, request);
  });
}

contextBridge.exposeInMainWorld("__globalsOwner", {
  /** Requests from the main process: open a window, read, or write. */
  onMainRequest(listener) {
    listeners.push(listener);
  },

  /** The reply to one of those requests. */
  reply(channel, message) {
    ipcRenderer.send(channel, message);
  },

  channels: CHANNEL,

  /**
   * The gate conditions, asserted by the renderer rather than trusted from configuration.
   * A window reporting these as false is misconfigured, and the runtime says so instead of
   * failing later with a transfer error nobody can trace.
   */
  environment: {
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
  },
});
