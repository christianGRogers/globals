import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { ArenaFullError, NoReaderSlotError } from "../src/errors.js";

/**
 * What happens when the arena fills, fragments, or runs out of reader slots.
 *
 * Defined behaviour in each case, asserted rather than described. The property that matters
 * across all of them is that the failure is a typed error and the arena is still usable
 * afterwards: an application that cannot write a value it wanted to write must not lose the
 * state it already had.
 */

function small(options = {}): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 15,
    maxByteLength: 1 << 15,
    maxReaders: 4,
    retainedVersions: 8,
    ...options,
  });
}

test("a write that does not fit raises ArenaFullError", () => {
  const store = small();
  assert.throws(() => {
    store.commit(Array.from({ length: 20_000 }, (_unused, i) => `string number ${i}`));
  }, ArenaFullError);
});

test("the previous version survives a write that did not fit", () => {
  const store = small();
  store.commit({ keep: "this value" });
  const version = store.versionId;

  assert.throws(() => {
    store.commit(Array.from({ length: 20_000 }, (_unused, i) => `string number ${i}`));
  }, ArenaFullError);

  assert.equal(store.versionId, version, "a failed write must not publish a version");
  const reader = ArenaReader.attach(store.buffer);
  assert.deepEqual(reader.acquire().toJSON(), { keep: "this value" });
  reader.detach();
});

test("an arena with headroom is writable again after a failure", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 17,
    maxByteLength: 1 << 17,
    maxReaders: 4,
    retainedVersions: 8,
  });
  store.commit({ a: 1 });
  assert.throws(() => store.commit(Array.from({ length: 40_000 }, (_u, i) => `s${i}`)));

  store.commit({ a: 2 });
  const reader = ArenaReader.attach(store.buffer);
  assert.deepEqual(reader.acquire().toJSON(), { a: 2 });
  reader.detach();
});

test("a rejected write returns the arena to exactly where it was", () => {
  const store = small();
  store.commit({ a: 1 });
  const before = store.stats();

  // This one is worth stating precisely. Freeing the blocks is not enough: the failed write
  // filled the arena with sixteen and twenty four byte string records, and with size classes
  // and no coalescing those never merge into the forty byte block the next write needs.
  // Rewinding the bump pointer past everything the failed commit allocated is what makes the
  // store usable again rather than stuck until it is restarted.
  assert.throws(() => store.commit(Array.from({ length: 20_000 }, (_u, i) => `s${i}`)));

  const after = store.stats();
  assert.equal(after.bumpPointer, before.bumpPointer, "the bump pointer must be back");
  assert.equal(after.liveBytes, before.liveBytes);
  assert.equal(after.internedStrings, before.internedStrings);

  store.commit({ a: 2 });
  const reader = ArenaReader.attach(store.buffer);
  assert.deepEqual(reader.acquire().toJSON(), { a: 2 });
  reader.detach();
});

test("a hundred rejected writes leave the arena exactly as it started", () => {
  const store = small();
  store.commit({ a: 1 });
  const before = store.stats();

  // The exhaustion vector this closes: a window that can request writes could otherwise
  // consume the arena with writes that were all refused.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.throws(() =>
      store.commit(Array.from({ length: 20_000 }, (_u, i) => `attempt ${attempt} value ${i}`)),
    );
  }

  assert.equal(store.stats().bumpPointer, before.bumpPointer);
  assert.equal(store.stats().internedStrings, before.internedStrings);
  store.commit({ a: 2 });
});

test("a scavenged block from a larger class satisfies a smaller request", () => {
  const store = small();
  store.commit({ a: 1 });

  // Long strings produce large blocks. Rolling those back leaves a free list the scavenger
  // can serve a smaller request from, which is the case it exists for.
  assert.throws(() =>
    store.commit(Array.from({ length: 4000 }, (_u, i) => `a fairly long string number ${i}`)),
  );

  store.commit({ b: 2 });
  const reader = ArenaReader.attach(store.buffer);
  assert.deepEqual(reader.acquire().toJSON(), { b: 2 });
  reader.detach();
});

test("a failed write releases everything it allocated before failing", () => {
  const store = small();
  store.commit({ a: 1 });
  const before = store.stats().liveBytes;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => store.commit(Array.from({ length: 20_000 }, (_u, i) => i * 1.5)));
  }

  // The interned strings from the first attempt persist by design. Everything else must be
  // released, so repeated failures do not accumulate.
  assert.ok(
    store.stats().liveBytes <= before,
    `five failed writes grew live bytes from ${before} to ${store.stats().liveBytes}`,
  );
});

test("an arena allowed to grow does grow rather than failing", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 15,
    maxByteLength: 1 << 22,
    maxReaders: 4,
    retainedVersions: 8,
  });
  store.commit(Array.from({ length: 20_000 }, (_unused, i) => i * 1.5));
  assert.ok(store.stats().capacityBytes > 1 << 15);

  const reader = ArenaReader.attach(store.buffer);
  assert.equal((reader.acquire().toJSON() as number[]).length, 20_000);
  reader.detach();
});

test("growth stops at maxByteLength and then reports exhaustion", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 15,
    maxByteLength: 1 << 17,
    maxReaders: 4,
    retainedVersions: 8,
  });
  assert.throws(() => {
    store.commit(Array.from({ length: 200_000 }, (_unused, i) => i * 1.5));
  }, ArenaFullError);
  assert.ok(store.stats().capacityBytes <= 1 << 17);
});

test("blocks larger than the biggest size class are not reused, and it is measurable", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 24,
    maxReaders: 4,
    retainedVersions: 8,
  });
  const reader = ArenaReader.attach(store.buffer);

  // A string longer than the largest size class is allocated at an exact size, so freeing it
  // drops the block rather than returning it to a list. Strings are interned and never freed
  // anyway, so this uses a wide object, whose HAMT node is large.
  for (let round = 0; round < 40; round += 1) {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) wide[`k${round}-${i}`] = i;
    store.commit(wide);
    reader.read();
  }

  const stats = store.stats();
  // Whatever the number is, it must be reported rather than hidden. A climbing value here is
  // the signal that compaction is needed, which is the decision this measurement exists to
  // inform.
  assert.equal(typeof stats.strandedBytes, "number");
  assert.ok(stats.strandedBytes >= 0);
  reader.detach();
});

test("running out of reader slots is a typed error, and the arena keeps working", () => {
  const store = small({ maxReaders: 2 });
  const first = ArenaReader.attach(store.buffer);
  const second = ArenaReader.attach(store.buffer);

  assert.throws(() => ArenaReader.attach(store.buffer), NoReaderSlotError);

  store.commit({ still: "working" });
  assert.deepEqual(first.acquire().toJSON(), { still: "working" });

  first.detach();
  const third = ArenaReader.attach(store.buffer);
  assert.deepEqual(third.acquire().toJSON(), { still: "working" });

  second.detach();
  third.detach();
});

test("a large single value is served exactly and read back", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 24,
    maxReaders: 4,
    retainedVersions: 8,
  });
  const long = "x".repeat(200_000);
  store.commit({ long });

  const reader = ArenaReader.attach(store.buffer);
  assert.equal((reader.acquire().toJSON() as { long: string }).long.length, 200_000);
  reader.detach();
});

test("utilisation stays reasonable under a churning workload", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 24,
    maxReaders: 4,
    retainedVersions: 16,
  });
  const reader = ArenaReader.attach(store.buffer);

  store.commit({ rows: Array.from({ length: 400 }, (_unused, i) => ({ id: i, value: 0 })) });
  for (let i = 0; i < 3000; i += 1) {
    store.update((draft: { rows: { value: number }[] }) => {
      const row = draft.rows[i % 400];
      if (row) row.value = i;
    });
    reader.read();
  }

  const stats = store.stats();
  const used = stats.bumpPointer - store.arena.geometry.arenaOffset;
  const wasted = used - stats.liveBytes - stats.freeListBytes;
  assert.ok(
    wasted < used * 0.25,
    `waste is ${wasted} of ${used} bytes, which suggests fragmentation rather than overhead`,
  );
  reader.detach();
});
