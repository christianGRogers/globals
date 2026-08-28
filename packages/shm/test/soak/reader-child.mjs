// One soak reader in its own OS process: sync continuously for the duration, require every
// copy to be exactly one commit and every version to be monotonic, and report progress as
// JSON lines the parent aggregates.
import { ReaderRegion } from "../../dist/src/index.js";

const [, , path, msArg, id] = process.argv;
const deadline = Date.now() + Number(msArg);

// The writer creates the region; attach when it exists and holds a header.
let reader = null;
while (reader === null) {
  try {
    reader = ReaderRegion.attach(path);
  } catch {
    if (Date.now() > deadline) {
      console.error("never attached");
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const dest = new Uint8Array(reader.dataSize);
let reads = 0;
let violations = 0;
let regressions = 0;
let lastVersion = 0;
let lastReport = Date.now();

while (Date.now() < deadline) {
  const version = reader.sync(dest);
  reads++;
  if (version < lastVersion) regressions++;
  lastVersion = version;
  const first = dest[0];
  for (let i = 1; i < dest.length; i++) {
    if (dest[i] !== first) {
      violations++;
      break;
    }
  }
  if (Date.now() - lastReport > 5000) {
    lastReport = Date.now();
    console.log(JSON.stringify({ id, reads, violations, regressions, lastVersion }));
  }
}

reader.close();
console.log(JSON.stringify({ id, final: true, reads, violations, regressions, lastVersion, pid: process.pid }));
