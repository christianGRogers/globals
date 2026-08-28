// Attaches to the region named by argv, waits for the first commit, validates the pattern
// the parent flushed, and reports. The process boundary is the point: this child shares no
// heap with its parent, so what it reads came through the mapping or not at all.
import { ReaderRegion } from "../../dist/src/index.js";

const [, , path, expectedSeed] = process.argv;
const seed = Number(expectedSeed);
const reader = ReaderRegion.attach(path);
const dest = new Uint8Array(reader.dataSize);

const deadline = Date.now() + 10_000;
let version = 0;
while (version === 0 && Date.now() < deadline) {
  version = reader.version();
}
if (version === 0) {
  console.error("no commit arrived");
  process.exit(2);
}

const synced = reader.sync(dest);
let bad = -1;
for (let i = 0; i < dest.length; i++) {
  if (dest[i] !== ((i + seed) % 251)) {
    bad = i;
    break;
  }
}
reader.close();
if (bad >= 0) {
  console.error(`byte ${bad} did not match the pattern`);
  process.exit(3);
}
console.log(JSON.stringify({ pid: process.pid, version: synced }));
