import { test } from "node:test";
import assert from "node:assert/strict";

import { SharedArena } from "../src/arena.js";
import { ArenaCorruptError } from "../src/errors.js";
import { Header, LAYOUT_VERSION, MAGIC, computeGeometry } from "../src/layout.js";

function freshBuffer(bytes = 1 << 16): SharedArrayBuffer {
  return new SharedArrayBuffer(bytes);
}

function format(bytes = 1 << 16): SharedArena {
  return SharedArena.format(freshBuffer(bytes), {
    maxReaders: 8,
    retainedCapacity: 16,
    flags: 0,
  });
}

test("a formatted arena carries the magic and the layout version", () => {
  const arena = format();
  assert.equal(arena.loadHeader(Header.Magic), MAGIC);
  assert.equal(arena.loadHeader(Header.LayoutVersion), LAYOUT_VERSION);
});

test("geometry places the regions in order and eight byte aligns the arena", () => {
  const geometry = computeGeometry(8, 16);
  assert.ok(geometry.readerTableOffset < geometry.retainedRingOffset);
  assert.ok(geometry.retainedRingOffset < geometry.arenaOffset);
  assert.equal(geometry.arenaOffset % 8, 0);
});

test("attach accepts a buffer this build formatted", () => {
  const arena = format();
  const attached = SharedArena.attach(arena.buffer);
  assert.equal(attached.geometry.arenaOffset, arena.geometry.arenaOffset);
});

test("attach rejects a buffer without the magic", () => {
  assert.throws(() => SharedArena.attach(freshBuffer()), ArenaCorruptError);
});

test("attach rejects a buffer that is too small to hold a header", () => {
  assert.throws(() => SharedArena.attach(new SharedArrayBuffer(64)), ArenaCorruptError);
});

test("attach rejects a layout version this build cannot read", () => {
  const arena = format();
  arena.words[Header.LayoutVersion] = LAYOUT_VERSION + 1;
  assert.throws(() => SharedArena.attach(arena.buffer), /layout version/);
});

test("attach rejects a stomped configuration header", () => {
  const arena = format();
  // A hostile or buggy window rewrites the reader table offset. Without the configuration
  // checksum this would silently point every reader at the wrong region.
  arena.words[Header.ReaderTableOffset] = 4096;
  assert.throws(() => SharedArena.attach(arena.buffer), /configuration checksum/);
});

test("format refuses a buffer smaller than its own bookkeeping", () => {
  assert.throws(
    () =>
      SharedArena.format(new SharedArrayBuffer(256), {
        maxReaders: 32,
        retainedCapacity: 64,
        flags: 0,
      }),
    ArenaCorruptError,
  );
});

test("checkRange rejects offsets before the arena region", () => {
  const arena = format();
  assert.throws(() => arena.checkRange(0, 8, "test"), /before the arena region/);
  assert.throws(
    () => arena.checkRange(arena.geometry.arenaOffset - 8, 8, "test"),
    /before the arena region/,
  );
});

test("checkRange rejects unaligned offsets", () => {
  const arena = format();
  assert.throws(
    () => arena.checkRange(arena.geometry.arenaOffset + 4, 8, "test"),
    /not eight byte aligned/,
  );
});

test("checkRange rejects a length that runs past the buffer", () => {
  const arena = format(1 << 16);
  assert.throws(
    () => arena.checkRange(arena.geometry.arenaOffset, 1 << 20, "test"),
    /past the end of the buffer/,
  );
});

test("checkBlock rejects an offset with no block header", () => {
  const arena = format();
  assert.throws(
    () => arena.checkBlock(arena.geometry.arenaOffset + 64, "test"),
    /no block header/,
  );
});

test("views pick up a growth on refresh, and only on refresh", () => {
  const buffer = new SharedArrayBuffer(1 << 16, { maxByteLength: 1 << 17 });
  const arena = SharedArena.format(buffer, { maxReaders: 4, retainedCapacity: 8, flags: 0 });
  assert.equal(arena.byteLength, 1 << 16);

  buffer.grow(1 << 17);
  // Deliberate: probing the buffer on every view access was the single most expensive
  // thing on the read path, so growth is picked up at an explicit synchronisation point.
  assert.equal(arena.byteLength, 1 << 16);

  arena.refresh();
  assert.equal(arena.byteLength, 1 << 17);
  assert.equal(arena.words.length, (1 << 17) / 4);
});
