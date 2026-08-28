// One boot of one chaos window. Every reload or recreation runs this again with a fresh
// boot id, which is exactly the reconnect path the harness exists to exercise.
//
// The invariant is read from one snapshot: counter and checksum must agree by arithmetic.
// Reading them through two separate selects could legitimately span two commits and report
// a violation that is not there, which is the mistake the verified-read work already made
// once on the owner side.
import { ipcRenderer } from "electron";

import { connectNative } from "../../dist/src/native/renderer.js";

const name =
  process.argv.find((a) => a.startsWith("--chaos-name="))?.slice("--chaos-name=".length) ??
  "chaos";
const boot = Math.random().toString(36).slice(2, 8);

async function run() {
  const stats = {
    window: name,
    boot,
    pid: process.pid,
    reads: 0,
    violations: 0,
    regressions: 0,
    lastVersion: 0,
    at: 0,
  };
  const store = await connectNative();

  const send = () => {
    stats.at = Date.now();
    ipcRenderer.send("chaos:stats", { ...stats });
  };

  setInterval(() => {
    const version = store.version;
    if (version < stats.lastVersion) stats.regressions += 1;
    stats.lastVersion = version;

    const snapshot = store.snapshot();
    const counter = snapshot.get(["counter"]);
    const checksum = snapshot.get(["checksum"]);
    stats.reads += 1;
    if (checksum !== (counter * 2654435761) % 0x7fffffff) {
      stats.violations += 1;
      console.log(`${name}#${boot}: INCONSISTENT counter=${counter} checksum=${checksum}`);
    }
  }, 5);

  setInterval(send, 250);
  send();
}

void run();
