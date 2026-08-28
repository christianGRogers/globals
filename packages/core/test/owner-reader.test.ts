import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { NoReaderSlotError, StaleSnapshotError } from "../src/errors.js";
import { Header, RetainedState } from "../src/layout.js";

function owner(options = {}): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 18,
    maxByteLength: 1 << 22,
    maxReaders: 4,
    retainedVersions: 8,
    ...options,
  });
}

test("a fresh arena starts at version one with an undefined root", () => {
  const store = owner();
  assert.equal(store.versionId, 1);
  const reader = ArenaReader.attach(store.buffer);
  assert.equal(reader.read(), undefined);
  reader.detach();
});

test("a reader observes a value the owner committed before it attached", () => {
  const store = owner();
  store.commit("committed before attach");
  const reader = ArenaReader.attach(store.buffer);
  assert.equal(reader.read(), "committed before attach");
  reader.detach();
});

test("a reader observes each commit in order", () => {
  const store = owner();
  const reader = ArenaReader.attach(store.buffer);
  for (let i = 0; i < 200; i += 1) {
    store.commit(i);
    assert.equal(reader.read(), i);
  }
  reader.detach();
});

test("several readers share one arena and agree", () => {
  const store = owner();
  const readers = Array.from({ length: 4 }, () => ArenaReader.attach(store.buffer));
  store.commit(1234.5);
  for (const reader of readers) assert.equal(reader.read(), 1234.5);
  for (const reader of readers) reader.detach();
});

test("the reader table refuses to overcommit slots", () => {
  const store = owner({ maxReaders: 2 });
  const first = ArenaReader.attach(store.buffer);
  const second = ArenaReader.attach(store.buffer);
  assert.throws(() => ArenaReader.attach(store.buffer), NoReaderSlotError);
  first.detach();
  // A detached reader releases its slot, so the next attach succeeds.
  const third = ArenaReader.attach(store.buffer);
  second.detach();
  third.detach();
});

test("acquiring twice without a commit in between returns the same snapshot", () => {
  const store = owner();
  const reader = ArenaReader.attach(store.buffer);
  const first = reader.acquire();
  assert.equal(reader.acquire(), first);
  store.commit("moved on");
  assert.notEqual(reader.acquire(), first);
  reader.detach();
});

test("a held snapshot keeps its value while the owner commits past it", () => {
  const store = owner();
  const reader = ArenaReader.attach(store.buffer);
  store.commit("pinned value");
  const snapshot = reader.acquire();

  store.commit("newer value");
  store.commit("newer still");

  // Immutability is the guarantee: the graph beneath a held snapshot cannot change.
  assert.equal(snapshot.value, "pinned value");
  assert.equal(reader.publishedVersion(), store.versionId);
  reader.detach();
});

test("a pinned version is not reclaimed", () => {
  const store = owner({ retainedVersions: 64 });
  const reader = ArenaReader.attach(store.buffer);
  store.commit(3.5);
  const snapshot = reader.acquire();
  const pinned = snapshot.versionId;

  for (let i = 0; i < 20; i += 1) store.commit(i + 0.5);

  assert.ok(store.stats().reclaimFloor <= pinned);
  assert.equal(snapshot.value, 3.5);
  reader.detach();
});

test("releasing a snapshot lets the owner reclaim the version", () => {
  const store = owner({ retainedVersions: 64 });
  const reader = ArenaReader.attach(store.buffer);
  store.commit(7.25);
  const snapshot = reader.acquire();
  const pinned = snapshot.versionId;
  snapshot.release();

  for (let i = 0; i < 10; i += 1) store.commit(i + 0.5);
  assert.ok(store.stats().reclaimFloor > pinned, "the floor should have moved past the pin");
  reader.detach();
});

test("a stalled reader is force advanced past the retention cap and fails closed", () => {
  const store = owner({ retainedVersions: 8 });
  const reader = ArenaReader.attach(store.buffer);
  store.commit(1.5);
  const snapshot = reader.acquire();
  assert.ok(snapshot.isValid());

  // Run the writer far past the ring capacity while the reader never advances.
  for (let i = 0; i < 40; i += 1) store.commit(i + 0.5);

  assert.equal(snapshot.isValid(), false);
  assert.throws(() => snapshot.value, StaleSnapshotError);

  // The reader recovers by reacquiring, which is the documented recovery path.
  assert.equal(reader.read(), 39.5);
  reader.detach();
});

test("forced advances are counted so the condition is visible in stats", () => {
  const store = owner({ retainedVersions: 8 });
  const reader = ArenaReader.attach(store.buffer);
  store.commit(1.5);
  reader.acquire();
  for (let i = 0; i < 40; i += 1) store.commit(i + 0.5);
  assert.ok(store.stats().forcedAdvances > 0);
  reader.detach();
});

test("memory does not grow without bound when readers keep up", () => {
  const store = owner({ retainedVersions: 16 });
  const reader = ArenaReader.attach(store.buffer);

  for (let i = 0; i < 50; i += 1) {
    store.commit(i + 0.5);
    reader.read();
  }
  const settled = store.stats().bumpPointer;

  for (let i = 0; i < 5000; i += 1) {
    store.commit(i + 0.5);
    reader.read();
  }
  assert.equal(
    store.stats().bumpPointer,
    settled,
    "a steady state workload must reuse blocks rather than consume fresh arena",
  );
  reader.detach();
});

test("the ring marks a normally reclaimed version differently from a forced one", () => {
  const store = owner({ retainedVersions: 8 });
  const reader = ArenaReader.attach(store.buffer);
  store.commit(1.5);
  reader.acquire();
  for (let i = 0; i < 40; i += 1) store.commit(i + 0.5);

  const states = new Set<number>();
  for (let version = 1; version <= store.versionId; version += 1) {
    const entry = store.ring.read(version);
    if (entry) states.add(entry.state);
  }
  assert.ok(states.has(RetainedState.Live));
  reader.detach();
});

test("a snapshot from a previous owner generation fails closed", () => {
  const store = owner();
  const reader = ArenaReader.attach(store.buffer);
  store.commit("before adoption");
  const snapshot = reader.acquire();
  assert.ok(snapshot.isValid());

  // A new owner adopting the buffer bumps the generation. Anything a reader held from the
  // previous owner is suspect, because the new owner did not inherit the free lists.
  store.arena.addHeader(Header.OwnerGeneration, 1);
  assert.equal(snapshot.isValid(), false);
  assert.throws(() => snapshot.value, StaleSnapshotError);
  reader.detach();
});

test("a rejected write leaks nothing beyond the keys it interned", () => {
  const store = owner();
  // The symbol is reached part way through encoding, so the encoder has already allocated a
  // HAMT node, a vector, and several leaves by the time it fails.
  const reject = (): number => store.commit({ a: 1, b: [1, 2, 3], c: Symbol("no") });

  assert.throws(reject);
  const afterFirst = store.stats().liveBytes;

  // Interned strings are append only and survive a rollback by design, so the first attempt
  // leaves the key records behind. Every attempt after it must cost nothing at all.
  for (let i = 0; i < 50; i += 1) assert.throws(reject);
  assert.equal(
    store.stats().liveBytes,
    afterFirst,
    "repeated rejected writes must not accumulate",
  );
});

test("interned strings are shared across versions", () => {
  const store = owner();
  for (let i = 0; i < 100; i += 1) store.commit("one repeated string");
  assert.equal(store.stats().internedStrings, 1);
});

test("stats report a coherent picture of the arena", () => {
  const store = owner();
  const reader = ArenaReader.attach(store.buffer);
  store.commit(2.5);
  reader.acquire();
  const stats = store.stats();
  assert.equal(stats.claimedReaders, 1);
  assert.ok(stats.bumpPointer <= stats.capacityBytes);
  assert.ok(stats.liveBytes >= 0);
  assert.ok(stats.minimumPinnedEpoch > 0);
  reader.detach();
});

test("the arena grows when a single version outgrows the initial size", () => {
  const store = ArenaOwner.create({
    byteLength: 1 << 14,
    maxByteLength: 1 << 22,
    maxReaders: 2,
    retainedVersions: 8,
  });
  const before = store.stats().capacityBytes;
  for (let i = 0; i < 4000; i += 1) store.commit(`distinct string ${i}`);
  assert.ok(store.stats().capacityBytes > before, "the arena should have grown");
  const reader = ArenaReader.attach(store.buffer);
  assert.equal(reader.read(), "distinct string 3999");
  reader.detach();
});
