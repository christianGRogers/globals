// The owner, as a SharedWorker rather than a hidden window.
//
// A SharedWorker is one instance shared by every same origin context, which is exactly the
// single writer the design needs, and its ports are created by Chromium rather than by
// Electron's serializer.
//
// Nothing here is allowed to throw at top level. A top level throw in a SharedWorker kills
// the script before onconnect is installed and surfaces nothing in the creating pages, which
// is indistinguishable from the worker not existing. Every fallible step is guarded and its
// outcome is reported to every page that connects.
let sab = null;
let creationError = null;
try {
  sab = new SharedArrayBuffer(1024);
  new Int32Array(sab)[0] = 0xC0FFEE;
} catch (error) {
  creationError = `${error.name}: ${error.message}`;
}

const ports = [];
let connections = 0;

function sendBuffer(port) {
  try {
    port.postMessage({ kind: "buffer", sab, connections });
  } catch (error) {
    port.postMessage({ kind: "post-threw", message: `${error.name}: ${error.message}` });
  }
}

self.onconnect = (event) => {
  const port = event.ports[0];
  ports.push(port);
  connections += 1;
  port.start();

  port.addEventListener("message", (message) => {
    if (message.data === "read-back") {
      port.postMessage({ kind: "read-back", value: sab ? new Int32Array(sab)[1] : -1 });
      return;
    }
    if (message.data && message.data.kind === "seed") {
      // The worker could not create the buffer itself, so a page made one and sent it
      // here. If it arrives intact, the worker becomes its owner and hands it out.
      try {
        sab = message.data.sab;
        new Int32Array(sab)[0] = 0xC0FFEE;
        for (const p of ports) sendBuffer(p);
      } catch (error) {
        port.postMessage({ kind: "seed-failed", message: `${error.name}: ${error.message}` });
      }
    }
  });
  port.addEventListener("messageerror", () => {
    port.postMessage({ kind: "worker-messageerror" });
  });

  port.postMessage({
    kind: "hello",
    workerCrossOriginIsolated: self.crossOriginIsolated === true,
    sabConstructor: typeof SharedArrayBuffer,
    creationError,
    connections,
  });
  if (sab) sendBuffer(port);
};
