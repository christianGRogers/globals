// Sandboxed preload. It bridges two things and nothing else: the port that arrives from
// the main process, and the report that goes back to it.
const { contextBridge, ipcRenderer } = require("electron");

const listeners = [];

ipcRenderer.on("spike:port", (event, payload) => {
  const port = event.ports[0];
  for (const listener of listeners) listener(port, payload);
});

contextBridge.exposeInMainWorld("spike", {
  onPort(listener) {
    listeners.push(listener);
  },
  report(data) {
    ipcRenderer.send("spike:report", data);
  },
  // process.contextIsolated is only true when contextIsolation is on, so the renderer can
  // assert the gate condition rather than trusting the configuration file.
  sandboxed: process.sandboxed === true && process.contextIsolated === true,
});
