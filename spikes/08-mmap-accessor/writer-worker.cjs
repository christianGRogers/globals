// The owner's write side during the torture window: publish the whole payload as fast as
// the machine allows, from a worker thread so the main process event loop stays free.
const { workerData, parentPort } = require("node:worker_threads");
const { join } = require("node:path");

const addon = require(join(__dirname, "build", "Release", "spike08.node"));
addon.open(workerData.path, workerData.size, false);

const end = Date.now() + workerData.ms;
let counter = 1;
while (Date.now() < end) addon.publish(counter++);

parentPort.postMessage({ publishes: counter - 1 });
