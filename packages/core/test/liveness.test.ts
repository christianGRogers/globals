import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { LivenessMonitor } from "../src/liveness.js";

function setup(): ArenaOwner {
  return ArenaOwner.create({
    byteLength: 1 << 18,
    maxByteLength: 1 << 22,
    maxReaders: 8,
    retainedVersions: 64,
  });
}

test("a reader that keeps reading is never reaped", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 3 });

  for (let i = 0; i < 20; i += 1) {
    owner.commit(i);
    reader.read();
    monitor.tick();
  }

  assert.equal(monitor.reapedCount, 0);
  assert.equal(owner.readers.isClaimed(reader.slot), true);
  reader.detach();
});

test("an idle reader that holds no pin is never reaped, however long it idles", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 2 });

  // Attached but never acquired, so it pins nothing and costs the writer nothing.
  for (let i = 0; i < 20; i += 1) monitor.tick();

  assert.equal(monitor.reapedCount, 0);
  assert.equal(owner.readers.isClaimed(reader.slot), true);
  reader.detach();
});

test("a reader frozen while holding a pin is reaped after the configured patience", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  owner.commit(1.5);
  reader.acquire();
  const slot = reader.slot;

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 3 });

  monitor.tick();
  monitor.tick();
  assert.equal(monitor.reapedCount, 0, "reaping before the patience runs out would be wrong");

  monitor.tick();
  monitor.tick();
  assert.equal(monitor.reapedCount, 1);
  assert.equal(owner.readers.isClaimed(slot), false);
});

test("reaping frees the memory the dead reader was pinning", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  owner.commit(1.5);
  reader.acquire();

  for (let i = 0; i < 5; i += 1) owner.commit(i + 0.5);
  const pinnedFloor = owner.stats().reclaimFloor;

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 1 });
  monitor.tick();
  monitor.tick();

  assert.equal(monitor.reapedCount, 1);
  assert.ok(
    owner.stats().reclaimFloor >= pinnedFloor,
    "the floor should not go backwards after a reap",
  );
  assert.equal(owner.stats().minimumPinnedEpoch, 0, "nothing should still be pinned");
});

test("a reaped slot is reusable, and the new claimant gets a new generation", () => {
  const owner = setup();
  const first = ArenaReader.attach(owner.buffer);
  owner.commit(1.5);
  first.acquire();
  const slot = first.slot;
  const generation = first.generation;

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 1 });
  monitor.tick();
  monitor.tick();

  const second = ArenaReader.attach(owner.buffer);
  assert.equal(second.slot, slot, "the reaped slot should be the first one free");
  assert.notEqual(second.generation, generation);
  second.detach();
});

test("a slot reclaimed by a new reader resets the patience counter", () => {
  const owner = setup();
  const first = ArenaReader.attach(owner.buffer);
  owner.commit(1.5);
  first.acquire();

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 3 });
  monitor.tick();
  monitor.tick();

  // The window reloads: the slot is released and immediately reclaimed by the new page.
  first.detach();
  const second = ArenaReader.attach(owner.buffer);
  second.acquire();

  monitor.tick();
  assert.equal(monitor.reapedCount, 0, "a fresh claimant must not inherit the old misses");
  second.detach();
});

test("reapSlot acts immediately, for a window the integration knows is gone", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  owner.commit(1.5);
  reader.acquire();

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 100 });
  monitor.reapSlot(reader.slot);

  assert.equal(monitor.reapedCount, 1);
  assert.equal(owner.readers.isClaimed(reader.slot), false);
});

test("a reaped reader fails closed rather than reading freed memory", () => {
  const owner = setup();
  const reader = ArenaReader.attach(owner.buffer);
  owner.commit(2.5);
  const snapshot = reader.acquire();
  assert.equal(snapshot.value, 2.5);

  const monitor = new LivenessMonitor(owner, { missesBeforeDead: 1 });
  monitor.tick();
  monitor.tick();

  // The reader is not stopped by being reaped, so it keeps running with a snapshot whose
  // version the owner may now recycle. Every subsequent commit walks the floor past it.
  for (let i = 0; i < 100; i += 1) owner.commit(i + 0.5);
  assert.equal(snapshot.isValid(), false);
});

test("the monitor bumps the owner heartbeat, so readers can detect a stalled owner", () => {
  const owner = setup();
  const monitor = new LivenessMonitor(owner);
  const before = owner.readers.ownerHeartbeat();
  monitor.tick();
  monitor.tick();
  assert.equal(owner.readers.ownerHeartbeat(), before + 2);
});
