// The reporting side channel for the sandboxed e2e window, kept out of the shipped preload
// because a generic report channel does not belong in an application-facing file. Sandboxed
// preloads cannot require each other, so this rides alongside preload-async.cjs through
// session.setPreloads.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("e2eReport", {
  send(observation) {
    ipcRenderer.send("e2e:report", observation);
  },
});
