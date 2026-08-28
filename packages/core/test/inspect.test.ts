import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { VersionHistory } from "../src/history.js";
import { diffShallow, formatArena, reportArena, reportReader } from "../src/inspect.js";
import { StaleSnapshotError } from "../src/errors.js";

function owner(historyDepth = 0): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 20,
    maxByteLength: 1 << 24,
    maxReaders: 8,
    retainedVersions: 16,
    historyDepth,
  });
}

test("the arena report describes what is in the arena", () => {
  const store = owner();
  store.commit({ count: 1, list: [1, 2, 3] });
  const reader = ArenaReader.attach(store.buffer);
  reader.acquire();

  const report = reportArena(store);
  assert.equal(report.version, store.versionId);
  assert.ok(report.liveBytes > 0);
  assert.ok(report.utilisation > 0 && report.utilisation <= 1);
  assert.equal(report.readers.length, 1);
  assert.equal(report.readers[0]?.lagVersions, 0);
  assert.ok(report.retained.length > 0);
  reader.detach();
});

test("the text report is readable and names the version and the sizes", () => {
  const store = owner();
  store.commit({ a: 1 });
  const text = formatArena(store);
  assert.match(text, /globals arena, layout \d+/);
  assert.match(text, /version\s+\d+/);
  assert.match(text, /live\s+[\d.]+ [KM]?B/);
  assert.match(text, /readers\s+none attached/);
});

test("a lagging reader is visible in the report", () => {
  const store = owner();
  store.commit(1);
  const reader = ArenaReader.attach(store.buffer);
  reader.acquire();
  for (let i = 0; i < 5; i += 1) store.commit(i);

  const report = reportArena(store);
  assert.equal(report.readers[0]?.lagVersions, 5);
  reader.detach();
});

test("a reader can see its own headroom before it is force advanced", () => {
  const store = owner();
  store.commit(1);
  const reader = ArenaReader.attach(store.buffer);
  reader.acquire();

  const fresh = reportReader(reader);
  assert.equal(fresh.lagVersions, 0);
  assert.equal(fresh.headroomVersions, 16);

  for (let i = 0; i < 10; i += 1) store.commit(i);
  const lagging = reportReader(reader);
  assert.equal(lagging.lagVersions, 10);
  assert.equal(lagging.headroomVersions, 6);
  reader.detach();
});

test("history is empty by default, because retention costs memory", () => {
  const store = owner();
  for (let i = 0; i < 5; i += 1) store.commit({ step: i });
  const reader = ArenaReader.attach(store.buffer);

  // Only the current version is readable. A version nothing is pinned to is reclaimed
  // immediately, which is the cheapest correct behaviour and leaves nothing to browse.
  assert.equal(new VersionHistory(reader).depth, 1);
  reader.detach();
});

test("history lists the retained versions oldest first", () => {
  const store = owner(8);
  for (let i = 0; i < 5; i += 1) store.commit({ step: i });
  const reader = ArenaReader.attach(store.buffer);
  const history = new VersionHistory(reader);

  const entries = history.list();
  assert.ok(entries.length >= 5);
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok((entries[i]?.versionId ?? 0) > (entries[i - 1]?.versionId ?? 0));
  }
  reader.detach();
});

test("a retained version can be read back", () => {
  const store = owner(8);
  store.commit({ step: "first" });
  const target = store.versionId;
  store.commit({ step: "second" });
  store.commit({ step: "third" });

  const reader = ArenaReader.attach(store.buffer);
  const history = new VersionHistory(reader);
  assert.deepEqual(history.read(target), { step: "first" });
  assert.deepEqual(reader.acquire().toJSON(), { step: "third" });
  reader.detach();
});

test("reading history does not disturb the pin a render is holding", () => {
  const store = owner(8);
  store.commit({ step: "first" });
  const first = store.versionId;
  store.commit({ step: "second" });

  const reader = ArenaReader.attach(store.buffer);
  const current = reader.acquire();
  const history = new VersionHistory(reader);

  history.read(first);

  assert.equal(reader.stats().pinnedEpoch, current.versionId);
  assert.equal(current.isValid(), true);
  reader.detach();
});

test("reading a version that has fallen off the ring fails closed", () => {
  const store = owner(8);
  store.commit({ step: 0 });
  const old = store.versionId;
  for (let i = 0; i < 60; i += 1) store.commit({ step: i });

  const reader = ArenaReader.attach(store.buffer);
  const history = new VersionHistory(reader);
  assert.throws(() => history.read(old), StaleSnapshotError);
  reader.detach();
});

test("a pinned historical version blocks reclamation until it is released", () => {
  const store = owner(4);
  store.commit({ step: "target" });
  const target = store.versionId;
  store.commit({ step: "next" });

  const reader = ArenaReader.attach(store.buffer);
  const history = new VersionHistory(reader);
  const pinned = history.pin(target);

  for (let i = 0; i < 5; i += 1) store.commit({ step: i });
  assert.ok(store.stats().reclaimFloor <= target);
  assert.deepEqual(pinned.toJSON(), { step: "target" });

  pinned.release();
  for (let i = 0; i < 5; i += 1) store.commit({ step: i });
  assert.ok(store.stats().reclaimFloor > target);
  reader.detach();
});

test("the shallow diff reports only what changed", () => {
  const changes = diffShallow({ a: 1, b: 2, c: 3 }, { a: 1, b: 99, d: 4 });
  const keys = changes.map((change) => change.key).sort();
  assert.deepEqual(keys, ["b", "c", "d"]);
});

test("the shallow diff handles scalars and null", () => {
  assert.deepEqual(diffShallow(1, 1), []);
  assert.equal(diffShallow(1, 2).length, 1);
  assert.equal(diffShallow(null, { a: 1 }).length, 1);
});
