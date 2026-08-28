import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";

/**
 * The phase 2 exit criterion.
 *
 * A realistic state shape round trips identically, and a single field write allocates a
 * bounded number of nodes rather than copying the tree. The bounds below are generous
 * against the theoretical minimum but far below the size of the structures, which is the
 * claim that matters: cost tracks depth, not size.
 */

interface Record_ {
  id: number;
  name: string;
  email: string;
  active: boolean;
  score: number;
  tags: string[];
}

function realisticState(size: number): { records: Record_[]; index: Record<string, number> } {
  const records = Array.from({ length: size }, (_unused, id) => ({
    id,
    name: `person ${id}`,
    email: `person${id}@example.test`,
    active: id % 4 !== 0,
    score: id * 1.5,
    tags: [`tag-${id % 10}`, `group-${id % 3}`],
  }));
  const index: Record<string, number> = {};
  for (const record of records) index[record.email] = record.id;
  return { records, index };
}

function owner(): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 22,
    maxByteLength: 1 << 27,
    maxReaders: 4,
    retainedVersions: 32,
  });
}

test("a few thousand records with nested objects and arrays round trip identically", () => {
  const store = owner();
  const state = realisticState(3000);
  store.commit(state);

  const reader = ArenaReader.attach(store.buffer);
  const result = reader.acquire().toJSON();
  assert.deepEqual(result, state);
  reader.detach();
});

test("setting one field of a wide object allocates a bounded number of nodes", () => {
  const store = owner();
  const wide: Record<string, number> = {};
  for (let i = 0; i < 10_000; i += 1) wide[`key-${i}`] = i;
  store.commit(wide);

  const before = store.allocator.stats().allocations;
  store.update((draft: Record<string, number>) => {
    draft["key-5000"] = 999;
  });
  const allocated = store.allocator.stats().allocations - before;

  // A trie of ten thousand keys is at most four levels deep, so a path copy is a handful of
  // nodes. Copying the record would be ten thousand entries.
  assert.ok(allocated < 20, `a single field write allocated ${allocated} blocks`);
});

test("setting one array element allocates a bounded number of nodes", () => {
  const store = owner();
  store.commit({ list: Array.from({ length: 10_000 }, (_unused, i) => i) });

  const before = store.allocator.stats().allocations;
  store.update((draft: { list: number[] }) => {
    draft.list[5000] = -1;
  });
  const allocated = store.allocator.stats().allocations - before;

  assert.ok(allocated < 20, `a single element write allocated ${allocated} blocks`);
});

test("setting one field deep in a realistic shape allocates a bounded number of nodes", () => {
  const store = owner();
  store.commit(realisticState(3000));

  const before = store.allocator.stats().allocations;
  store.update((draft: { records: Record_[] }) => {
    const record = draft.records[1500];
    if (record) record.name = "renamed";
  });
  const allocated = store.allocator.stats().allocations - before;

  assert.ok(allocated < 40, `a nested field write allocated ${allocated} blocks`);
});

test("a write leaves every untouched subtree at the same arena offset", () => {
  const store = owner();
  store.commit({ kept: { deep: [1, 2, 3] }, changed: { value: 1 } });

  const reader = ArenaReader.attach(store.buffer);
  const beforeSlot = reader.acquire().get(["kept", "deep", 0]);
  assert.equal(beforeSlot, 1);

  const liveBefore = store.stats().liveBytes;
  store.update((draft: { changed: { value: number } }) => {
    draft.changed.value = 2;
  });
  const liveAfter = store.stats().liveBytes;

  // Structural sharing means the write costs the copied path only. If untouched subtrees
  // were copied, live bytes would roughly double.
  assert.ok(
    liveAfter - liveBefore < 400,
    `an isolated write grew live bytes by ${liveAfter - liveBefore}`,
  );
  assert.equal(reader.acquire().get(["kept", "deep", 0]), 1);
  reader.detach();
});

test("repeated writes reach a steady state rather than growing the arena", () => {
  const store = owner();
  store.commit(realisticState(500));
  const reader = ArenaReader.attach(store.buffer);

  for (let i = 0; i < 200; i += 1) {
    store.update((draft: { records: Record_[] }) => {
      const record = draft.records[i % 500];
      if (record) record.score = i;
    });
    reader.acquire();
  }
  const settled = store.stats().bumpPointer;

  for (let i = 0; i < 2000; i += 1) {
    store.update((draft: { records: Record_[] }) => {
      const record = draft.records[i % 500];
      if (record) record.score = i;
    });
    reader.acquire();
  }

  const growth = store.stats().bumpPointer - settled;
  assert.ok(
    growth === 0,
    `two thousand further writes consumed ${growth} fresh bytes, so blocks are not being reused`,
  );
  reader.detach();
});

test("a held snapshot still reads its own version after many writes", () => {
  const store = owner();
  store.commit({ counter: 0, payload: Array.from({ length: 100 }, (_unused, i) => i) });

  const reader = ArenaReader.attach(store.buffer);
  const pinned = reader.acquire();
  const pinnedValue = pinned.toJSON();

  for (let i = 1; i <= 20; i += 1) {
    store.update((draft: { counter: number }) => {
      draft.counter = i;
    });
  }

  assert.deepEqual(pinned.toJSON(), pinnedValue);
  assert.equal((reader.acquire().toJSON() as { counter: number }).counter, 20);
  reader.detach();
});
