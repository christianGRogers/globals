import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { GlobalsError } from "../src/errors.js";

interface State {
  count: number;
  user: { name: string; tags: string[] };
  rows: { id: number; label: string }[];
}

function setup(initial: unknown = null): { store: ArenaOwner; read: () => unknown } {
  const store = ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 26,
    maxReaders: 4,
    retainedVersions: 32,
  });
  if (initial !== null) store.commit(initial);
  const reader = ArenaReader.attach(store.buffer);
  return { store, read: () => reader.acquire().toJSON() };
}

const BASE: State = {
  count: 0,
  user: { name: "first", tags: ["a", "b"] },
  rows: [
    { id: 1, label: "one" },
    { id: 2, label: "two" },
  ],
};

test("setting a top level field leaves everything else identical", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    draft.count = 5;
  });
  assert.deepEqual(read(), { ...BASE, count: 5 });
});

test("setting a nested field rebuilds only that path", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    draft.user.name = "second";
  });
  assert.deepEqual(read(), { ...BASE, user: { ...BASE.user, name: "second" } });
});

test("setting an array element by index works", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    draft.rows[1] = { id: 2, label: "changed" };
  });
  assert.deepEqual((read() as State).rows[1], { id: 2, label: "changed" });
});

test("setting a field inside an array element works", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    const row = draft.rows[0];
    if (row) row.label = "edited";
  });
  assert.deepEqual((read() as State).rows[0], { id: 1, label: "edited" });
  assert.deepEqual((read() as State).rows[1], { id: 2, label: "two" });
});

test("adding a key works", () => {
  const { store, read } = setup(BASE);
  store.update((draft: Record<string, unknown>) => {
    draft.added = { nested: true };
  });
  assert.deepEqual((read() as Record<string, unknown>).added, { nested: true });
});

test("deleting a key works", () => {
  const { store, read } = setup(BASE);
  store.update((draft: Record<string, unknown>) => {
    delete draft.count;
  });
  const result = read() as Record<string, unknown>;
  assert.equal("count" in result, false);
  assert.deepEqual(result.user, BASE.user);
});

test("push and pop work on an array draft", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    draft.user.tags.push("c", "d");
  });
  assert.deepEqual((read() as State).user.tags, ["a", "b", "c", "d"]);

  store.update((draft: State) => {
    const popped = draft.user.tags.pop();
    assert.equal(popped, "d");
  });
  assert.deepEqual((read() as State).user.tags, ["a", "b", "c"]);
});

test("splice rebuilds the array and produces the right result", () => {
  const { store, read } = setup({ list: [1, 2, 3, 4, 5] });
  store.update((draft: { list: number[] }) => {
    draft.list.splice(1, 2, 99);
  });
  assert.deepEqual((read() as { list: number[] }).list, [1, 99, 4, 5]);
});

test("sort and reverse work through the rebuild path", () => {
  const { store, read } = setup({ list: [3, 1, 2] });
  store.update((draft: { list: number[] }) => {
    draft.list.sort((a, b) => a - b);
  });
  assert.deepEqual((read() as { list: number[] }).list, [1, 2, 3]);

  store.update((draft: { list: number[] }) => {
    draft.list.reverse();
  });
  assert.deepEqual((read() as { list: number[] }).list, [3, 2, 1]);
});

test("reading through a draft without writing commits nothing", () => {
  const { store } = setup(BASE);
  const before = store.versionId;
  store.update((draft: State) => {
    void draft.user.name;
    void draft.rows[0]?.label;
  });
  assert.equal(store.versionId, before, "a recipe that changes nothing must not bump a version");
});

test("a draft reads its own writes", () => {
  const { store, read } = setup(BASE);
  store.update((draft: State) => {
    draft.count = 10;
    assert.equal(draft.count, 10);
    draft.count = draft.count + 5;
  });
  assert.equal((read() as State).count, 15);
});

test("a recipe that throws leaves the published version untouched", () => {
  const { store, read } = setup(BASE);
  const before = store.versionId;
  assert.throws(() => {
    store.update((draft: State) => {
      draft.count = 99;
      throw new Error("recipe failed");
    });
  }, /recipe failed/);
  assert.equal(store.versionId, before);
  assert.deepEqual(read(), BASE);
});

test("update refuses a scalar root, and says what to do instead", () => {
  const { store } = setup(42);
  assert.throws(() => store.update(() => undefined), GlobalsError);
});

test("iteration and spread work on an array draft", () => {
  const { store, read } = setup({ list: [1, 2, 3] });
  store.update((draft: { list: number[] }) => {
    const doubled = [...draft.list].map((n) => n * 2);
    draft.list = doubled;
  });
  assert.deepEqual((read() as { list: number[] }).list, [2, 4, 6]);
});

test("Object.keys on a draft reflects additions and deletions", () => {
  const { store } = setup({ a: 1, b: 2 });
  store.update((draft: Record<string, unknown>) => {
    draft.c = 3;
    delete draft.a;
    assert.deepEqual(Object.keys(draft).sort(), ["b", "c"]);
  });
});

test("a reader sees each update in order", () => {
  const { store, read } = setup({ count: 0 });
  for (let i = 1; i <= 100; i += 1) {
    store.update((draft: { count: number }) => {
      draft.count = i;
    });
    assert.equal((read() as { count: number }).count, i);
  }
});
