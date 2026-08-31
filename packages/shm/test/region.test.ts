import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OwnerRegion, ReaderRegion, LAYOUT_VERSION } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "globals-shm-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const regionPath = () => join(dir, `region-${n++}.mem`);

const SIZE = 64 * 1024;

test("a flushed commit round trips through an attached reader", () => {
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);
  assert.equal(reader.dataSize, SIZE);
  assert.equal(owner.version(), 0);
  assert.equal(reader.version(), 0);

  const src = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) src[i] = (i * 7 + 3) & 0xff;
  const version = owner.flush(src);
  assert.equal(version, 1);
  assert.equal(reader.version(), 1);

  const dest = new Uint8Array(SIZE);
  assert.equal(reader.sync(dest), 1);
  assert.deepEqual(dest, src);

  owner.close();
  reader.close();
});

test("a range flush touches only the range it names", () => {
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);

  const src = new Uint8Array(SIZE).fill(0xaa);
  owner.flush(src);

  src.fill(0xbb, 100, 300);
  src.fill(0xcc, 40_000, 40_016);
  // Deliberately also dirty a byte the ranges do not cover: it must not be published.
  src[500] = 0xdd;
  const version = owner.flush(src, [
    [100, 200],
    [40_000, 16],
  ]);
  assert.equal(version, 2);

  const dest = new Uint8Array(SIZE);
  assert.equal(reader.sync(dest), 2);
  assert.equal(dest[100], 0xbb);
  assert.equal(dest[299], 0xbb);
  assert.equal(dest[40_015], 0xcc);
  assert.equal(dest[500], 0xaa, "an unflushed byte must keep its committed value");

  owner.close();
  reader.close();
});

test("versions count commits, and version zero means empty", () => {
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  const src = new Uint8Array(SIZE);
  for (let i = 1; i <= 5; i++) assert.equal(owner.flush(src, [[0, 16]]), i);
  assert.equal(owner.version(), 5);
  owner.close();
});

test("a region opens under a path that is not in any ANSI code page", () => {
  // The reason this test exists is Windows. The region lives under userData, which carries
  // the account name, and the ANSI entry points cannot express a path outside the active
  // code page: an accented or non-Latin account name meant ESHM_IO at startup with nothing
  // explaining it. POSIX passes this either way, so the assertion it is really making is
  // only checked on one platform, which is worth stating rather than discovering.
  const awkward = join(dir, "régión-Ωμέγα-世界-🧠");
  mkdirSync(awkward, { recursive: true });
  const path = join(awkward, "region.mem");

  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);
  const src = new Uint8Array(SIZE).fill(0x5a);
  assert.equal(owner.flush(src), 1);

  const dest = new Uint8Array(SIZE);
  assert.equal(reader.sync(dest), 1);
  assert.deepEqual(dest, src);

  owner.close();
  reader.close();
});

test("attach refuses a region file shorter than its header declares", () => {
  // Before this was checked, attach believed the header and mmap succeeded past end of
  // file, so the fault arrived when a reader touched the page: SIGBUS, a process kill that
  // no caller can catch and ESHM_* cannot report. A full disk or an interrupted copy took
  // down every window that attached. Verified as a crash before the fix, and this asserts
  // it is an error after it.
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  owner.flush(new Uint8Array(SIZE).fill(0xab));
  owner.close();

  truncateSync(path, 4096);
  assert.throws(() => ReaderRegion.attach(path), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_TRUNCATED");
    return true;
  });
});

test("attach refuses a header declaring an impossible data size", () => {
  // The declared size drives the mapping length and the slot arithmetic on top of it, so a
  // corrupt one has to be rejected before it is believed rather than after.
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  owner.close();

  const header = Buffer.alloc(8);
  header.writeBigUInt64LE((1n << 50n), 0);
  const handle = openSync(path, "r+");
  writeSync(handle, header, 0, 8, 16);
  closeSync(handle);

  assert.throws(() => ReaderRegion.attach(path), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_LAYOUT");
    return true;
  });
});

test("a commit smaller than the one before it does not corrupt the range bookkeeping", () => {
  // The previous-commit ranges are grown before the seqlock section, and the capacity is
  // tracked apart from the count. Alternating a wide commit with a narrow one exercises
  // both: the narrow commit must not shrink the buffer the next wide one relies on, and
  // every commit must still publish exactly what it declared.
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);
  const src = new Uint8Array(SIZE);
  const dest = new Uint8Array(SIZE);

  const wide = Array.from({ length: 12 }, (_, i): [number, number] => [i * 512, 256]);
  const narrow: [number, number][] = [[0, 8]];

  for (let round = 1; round <= 6; round++) {
    const ranges = round % 2 === 1 ? wide : narrow;
    src.fill(round, 0, SIZE);
    const version = owner.flush(src, ranges);
    assert.equal(reader.sync(dest), version);
    for (const [offset, length] of ranges) {
      assert.equal(dest[offset], round, `round ${round} offset ${offset}`);
      assert.equal(dest[offset + length - 1], round);
    }
  }

  owner.close();
  reader.close();
});

test("attach refuses a missing file, a foreign file, and a wrong layout", () => {
  assert.throws(() => ReaderRegion.attach(join(dir, "absent.mem")), /could not open/);

  const foreign = regionPath();
  writeFileSync(foreign, "this is not a region and never will be, padded well past sixty four bytes");
  assert.throws(() => ReaderRegion.attach(foreign), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_MAGIC");
    return true;
  });

  const wrongLayout = regionPath();
  const owner = OwnerRegion.create(wrongLayout, 1024);
  owner.close();
  const bytes = new Uint8Array(64 + 1024);
  bytes.set([0x47, 0x53, 0x4d, 0x31], 0);
  bytes[4] = LAYOUT_VERSION + 1;
  bytes[16] = 0;
  bytes[17] = 4; // dataSize 1024
  writeFileSync(wrongLayout, bytes);
  assert.throws(() => ReaderRegion.attach(wrongLayout), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_LAYOUT");
    return true;
  });
});

test("misuse fails closed with typed errors", () => {
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  const reader = ReaderRegion.attach(path);
  const src = new Uint8Array(SIZE);

  assert.throws(() => owner.flush(src, [[SIZE - 8, 16]]), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_BOUNDS");
    return true;
  });
  assert.throws(() => reader.sync(new Uint8Array(SIZE - 1)), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_BOUNDS");
    return true;
  });

  reader.close();
  assert.throws(() => reader.sync(new Uint8Array(SIZE)), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_CLOSED");
    return true;
  });
  owner.close();
  assert.throws(() => owner.flush(src), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_CLOSED");
    return true;
  });
});

test("a short source under a full flush is refused", () => {
  const path = regionPath();
  const owner = OwnerRegion.create(path, SIZE);
  assert.throws(() => owner.flush(new Uint8Array(SIZE - 1)), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ESHM_BOUNDS");
    return true;
  });
  owner.close();
});
