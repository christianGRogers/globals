import { test } from "node:test";
import assert from "node:assert/strict";

import { SharedArena } from "../src/arena.js";
import { Allocator, SIZE_CLASSES } from "../src/allocator.js";
import { ArenaFullError } from "../src/errors.js";
import { Header } from "../src/layout.js";

function setup(bytes = 1 << 16): { arena: SharedArena; allocator: Allocator } {
  const arena = SharedArena.format(new SharedArrayBuffer(bytes), {
    maxReaders: 4,
    retainedCapacity: 8,
    flags: 0,
  });
  return { arena, allocator: new Allocator(arena) };
}

test("every allocation is eight byte aligned and inside the arena region", () => {
  const { arena, allocator } = setup();
  for (const size of [1, 7, 8, 9, 100, 1000]) {
    const offset = allocator.allocate(size);
    assert.equal(offset % 8, 0, `offset ${offset} for size ${size} is not aligned`);
    assert.ok(offset >= arena.geometry.arenaOffset);
    assert.ok(offset + size <= arena.byteLength);
  }
});

test("every allocation carries a validatable block header", () => {
  const { arena, allocator } = setup();
  const offset = allocator.allocate(64);
  const size = arena.checkBlock(offset, "test");
  assert.ok(size >= 64);
});

test("a request rounds up to a size class", () => {
  const { arena, allocator } = setup();
  const offset = allocator.allocate(20);
  assert.equal(arena.checkBlock(offset, "test"), 24);
});

test("a freed block is reused by the next request in the same class", () => {
  const { allocator } = setup();
  const first = allocator.allocate(64);
  allocator.free(first);
  const second = allocator.allocate(64);
  assert.equal(second, first, "the free list should have returned the same block");
});

test("a freed block is not reused by a request in a different class", () => {
  const { allocator } = setup();
  const first = allocator.allocate(64);
  allocator.free(first);
  const second = allocator.allocate(256);
  assert.notEqual(second, first);
});

test("live bytes track allocation and freeing", () => {
  const { allocator } = setup();
  const before = allocator.stats().liveBytes;
  const offset = allocator.allocate(128);
  assert.equal(allocator.stats().liveBytes, before + 128);
  allocator.free(offset);
  assert.equal(allocator.stats().liveBytes, before);
});

test("allocations larger than the biggest size class are served exactly", () => {
  const { arena, allocator } = setup(1 << 18);
  const biggest = SIZE_CLASSES[SIZE_CLASSES.length - 1] as number;
  const offset = allocator.allocate(biggest * 4);
  assert.equal(arena.checkBlock(offset, "test"), biggest * 4);
});

test("an exhausted arena that cannot grow raises ArenaFullError", () => {
  const { allocator } = setup(1 << 14);
  assert.throws(() => {
    for (let i = 0; i < 10_000; i += 1) allocator.allocate(4096);
  }, ArenaFullError);
});

test("an exhausted arena grows when a grow hook is supplied", () => {
  const buffer = new SharedArrayBuffer(1 << 14, { maxByteLength: 1 << 18 });
  const arena = SharedArena.format(buffer, { maxReaders: 4, retainedCapacity: 8, flags: 0 });
  const allocator = new Allocator(arena, (minimum) => {
    const wanted = Math.min(buffer.maxByteLength, buffer.byteLength * 2 + minimum);
    if (wanted <= buffer.byteLength) return false;
    buffer.grow(wanted);
    return true;
  });

  for (let i = 0; i < 20; i += 1) allocator.allocate(2048);
  assert.ok(arena.byteLength > 1 << 14, "the arena should have grown");
  assert.equal(arena.loadHeader(Header.BumpPointer) <= arena.byteLength, true);
});

test("repeated allocate and free cycles do not advance the bump pointer", () => {
  const { allocator } = setup();
  const warm = allocator.allocate(128);
  allocator.free(warm);
  const bumpAfterWarmup = allocator.stats().bumpPointer;

  for (let i = 0; i < 1000; i += 1) {
    const offset = allocator.allocate(128);
    allocator.free(offset);
  }
  assert.equal(
    allocator.stats().bumpPointer,
    bumpAfterWarmup,
    "a balanced workload must not consume fresh arena",
  );
});

test("stranded bytes stay at zero for a balanced workload", () => {
  const { allocator } = setup();
  const offsets = Array.from({ length: 50 }, () => allocator.allocate(96));
  for (const offset of offsets) allocator.free(offset);
  assert.equal(allocator.strandedBytes(), 0);
});
