// Sandboxed preload. It bridges two things and nothing else: the port that arrives from
// the main process, and the report that goes back to it.
const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("spike:port", (event, payload) => {
  // A MessagePort cannot be handed through contextBridge. The bridge serialises what passes
  // over it, so what arrives in the page is an object with the port's own properties and
  // none of its prototype: calling start() or addEventListener() on it throws.
  //
  // window.postMessage transfers a real port into the main world instead, which is the only
  // way to get a working MessagePort across an isolated context boundary.
  window.postMessage({ spikePort: payload }, "*", [event.ports[0]]);
});

contextBridge.exposeInMainWorld("spike", {
  report(data) {
    ipcRenderer.send("spike:report", data);
  },

  // process.contextIsolated is only true when contextIsolation is on, so the renderer can
  // assert the gate condition rather than trusting the configuration file.
  sandboxed: process.sandboxed === true && process.contextIsolated === true,
});
