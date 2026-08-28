// Creates the region and publishes at full rate for the requested duration: every commit
// fills the block with one byte value, so any mixture of two values inside a synced copy is
// a torn read, which is the failure the seqlock exists to prevent.
import { OwnerRegion } from "../../dist/src/index.js";

const [, , path, sizeArg, msArg] = process.argv;
const size = Number(sizeArg);
const owner = OwnerRegion.create(path, size);
const src = new Uint8Array(size);

// The parent attaches after it sees the file; give it one committed state immediately.
src.fill(1);
owner.flush(src);

const end = Date.now() + Number(msArg);
let counter = 1;
while (Date.now() < end) {
  counter = (counter % 250) + 1;
  src.fill(counter);
  owner.flush(src);
}
const version = owner.version();
owner.close();
console.log(JSON.stringify({ pid: process.pid, version }));
