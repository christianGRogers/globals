import { parentPort } from "node:worker_threads";

// Stands in for the process that would answer ipcRenderer.invoke. It does the least work
// a real handler could do, so the measurement is a floor on round trip cost rather than a
// measurement of the handler.
parentPort.on("message", (message) => {
  parentPort.postMessage({ id: message.id, value: message.value });
});
