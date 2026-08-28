// One end-to-end pass over a freshly built addon: create, attach, flush ranges, sync, and
// check every guarantee cheaply. The prebuild workflow runs this on each platform before it
// uploads anything, so a binary that loads but lies never ships.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OwnerRegion, ReaderRegion, LAYOUT_VERSION } from "../dist/src/index.js";

const dir = mkdtempSync(join(tmpdir(), "globals-shm-smoke-"));
try {
  const path = join(dir, "smoke.mem");
  const SIZE = 128 * 1024;
  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);
  assert.equal(reader.dataSize, SIZE);
  assert.equal(reader.version(), 0);

  const mirror = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) mirror[i] = (i * 31 + 7) & 0xff;
  assert.equal(owner.flush(mirror), 1);

  mirror.fill(0x5a, 1000, 1256);
  assert.equal(owner.flush(mirror, [[1000, 256]]), 2);

  const copy = new Uint8Array(SIZE);
  assert.equal(reader.sync(copy), 2);
  assert.deepEqual(copy, mirror);

  owner.close();
  reader.close();
  console.log(
    `smoke ok: layout ${LAYOUT_VERSION}, ${process.platform}-${process.arch}, node ${process.versions.node}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
