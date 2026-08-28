// The owner, as a SharedWorker rather than a hidden window.
//
// A SharedWorker is one instance shared by every same origin context, which is exactly the
// single writer the design needs, and its ports are created by Chromium rather than by
// Electron's serializer.
const sab = new SharedArrayBuffer(1024);
new Int32Array(sab)[0] = 0xC0FFEE;

let connections = 0;

self.onconnect = (event) => {
  const port = event.ports[0];
  connections += 1;
  port.start();

  port.addEventListener("message", (message) => {
    if (message.data === "read-back") {
      port.postMessage({ kind: "read-back", value: new Int32Array(sab)[1] });
    }
  });

  try {
    port.postMessage({ kind: "buffer", sab, connections });
  } catch (error) {
    port.postMessage({ kind: "post-threw", message: `${error.name}: ${error.message}` });
  }
};
