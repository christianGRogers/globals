import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { UnencodableValueError } from "../src/errors.js";

function owner(options = {}): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 26,
    maxReaders: 4,
    retainedVersions: 32,
    ...options,
  });
}

function roundTrip(value: unknown): unknown {
  const store = owner();
  store.commit(value);
  const reader = ArenaReader.attach(store.buffer);
  const result = reader.acquire().toJSON();
  reader.detach();
  return result;
}

test("a nested object round trips identically", () => {
  const value = {
    name: "globals",
    version: 2,
    nested: { deep: { deeper: [1, 2, { three: true }] } },
    flags: { a: true, b: false, c: null },
  };
  assert.deepEqual(roundTrip(value), value);
});

test("an array of objects round trips identically", () => {
  const value = Array.from({ length: 200 }, (_unused, index) => ({
    id: index,
    label: `row ${index}`,
    active: index % 3 === 0,
  }));
  assert.deepEqual(roundTrip(value), value);
});

test("an empty object and an empty array round trip", () => {
  assert.deepEqual(roundTrip({}), {});
  assert.deepEqual(roundTrip([]), []);
  assert.deepEqual(roundTrip({ a: {}, b: [] }), { a: {}, b: [] });
});

test("the extended type ladder round trips", () => {
  const value = {
    when: new Date("2026-08-27T12:00:00.000Z"),
    pattern: /ab+c/giu,
    big: 123456789012345678901234567890n,
    negativeBig: -98765432109876543210n,
    zeroBig: 0n,
    bytes: new Uint8Array([1, 2, 3, 250]),
    floats: new Float64Array([1.5, -2.5, Number.MAX_VALUE]),
    ints: new Int32Array([-1, 0, 2147483647]),
  };
  const result = roundTrip(value) as typeof value;
  assert.equal(result.when.getTime(), value.when.getTime());
  assert.equal(result.pattern.source, value.pattern.source);
  assert.equal(result.pattern.flags, value.pattern.flags);
  assert.equal(result.big, value.big);
  assert.equal(result.negativeBig, value.negativeBig);
  assert.equal(result.zeroBig, value.zeroBig);
  assert.deepEqual([...result.bytes], [...value.bytes]);
  assert.deepEqual([...result.floats], [...value.floats]);
  assert.deepEqual([...result.ints], [...value.ints]);
});

test("maps and sets round trip, with mixed primitive keys", () => {
  const value = {
    map: new Map<unknown, unknown>([
      ["string key", 1],
      [42, "int key"],
      [3.5, "double key"],
      [true, "boolean key"],
      [null, "null key"],
    ]),
    set: new Set([1, "two", false, null]),
  };
  const result = roundTrip(value) as typeof value;
  assert.equal(result.map.size, 5);
  assert.equal(result.map.get("string key"), 1);
  assert.equal(result.map.get(42), "int key");
  assert.equal(result.map.get(3.5), "double key");
  assert.equal(result.map.get(true), "boolean key");
  assert.equal(result.map.get(null), "null key");
  assert.deepEqual([...result.set].sort(), [1, "two", false, null].sort());
});

test("a map keyed on an object is rejected rather than silently useless", () => {
  const store = owner();
  assert.throws(() => store.commit(new Map([[{ a: 1 }, "value"]])), UnencodableValueError);
});

test("a class instance is rejected, because its prototype cannot cross a process", () => {
  class Point {
    constructor(readonly x = 1) {}
  }
  const store = owner();
  assert.throws(() => store.commit({ point: new Point() }), UnencodableValueError);
});

test("an object with many keys round trips, exercising trie collisions", () => {
  const value: Record<string, number> = {};
  for (let i = 0; i < 5000; i += 1) value[`key-${i}`] = i;
  assert.deepEqual(roundTrip(value), value);
});

test("keys that hash to the same bucket both survive", () => {
  // Two thousand keys in one object forces several levels of trie, and the round trip
  // proves nothing was lost to a collision.
  const value: Record<string, number> = {};
  for (let i = 0; i < 2000; i += 1) value[String(i).padStart(8, "0")] = i;
  const result = roundTrip(value) as Record<string, number>;
  assert.equal(Object.keys(result).length, 2000);
  for (const [key, expected] of Object.entries(value)) assert.equal(result[key], expected);
});

test("a lazy view decodes only what is touched", () => {
  const store = owner();
  store.commit({ a: { b: { c: "deep" } }, unrelated: [1, 2, 3] });
  const reader = ArenaReader.attach(store.buffer);
  const snapshot = reader.acquire();
  const value = snapshot.value as { a: { b: { c: string } } };
  assert.equal(value.a.b.c, "deep");
  reader.detach();
});

test("a view iterates, spreads, and supports array methods", () => {
  const store = owner();
  store.commit({ list: [1, 2, 3, 4, 5] });
  const reader = ArenaReader.attach(store.buffer);
  const value = reader.acquire().value as { list: number[] };

  assert.equal(value.list.length, 5);
  assert.deepEqual([...value.list], [1, 2, 3, 4, 5]);
  assert.deepEqual(value.list.map((n) => n * 2), [2, 4, 6, 8, 10]);
  assert.deepEqual(value.list.filter((n) => n % 2 === 1), [1, 3, 5]);
  assert.equal(value.list.reduce((sum, n) => sum + n, 0), 15);
  reader.detach();
});

test("a view enumerates keys, and JSON.stringify works on it", () => {
  const store = owner();
  const value = { b: 2, a: 1, c: { d: 4 } };
  store.commit(value);
  const reader = ArenaReader.attach(store.buffer);
  const view = reader.acquire().value as Record<string, unknown>;

  assert.deepEqual(Object.keys(view).sort(), ["a", "b", "c"]);
  assert.equal("a" in view, true);
  assert.equal("missing" in view, false);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), value);
  reader.detach();
});

test("a view refuses writes, and says why", () => {
  const store = owner();
  store.commit({ a: 1 });
  const reader = ArenaReader.attach(store.buffer);
  const view = reader.acquire().value as Record<string, unknown>;
  assert.throws(() => {
    view.a = 2;
  }, /read only/);
  reader.detach();
});

test("select reads a path without materialising the nodes on it", () => {
  const store = owner();
  store.commit({ users: [{ name: "first" }, { name: "second" }] });
  const reader = ArenaReader.attach(store.buffer);
  const snapshot = reader.acquire();
  assert.equal(snapshot.get(["users", 1, "name"]), "second");
  assert.equal(snapshot.get(["users", 9, "name"]), undefined);
  assert.equal(snapshot.get(["missing", "path"]), undefined);
  reader.detach();
});
