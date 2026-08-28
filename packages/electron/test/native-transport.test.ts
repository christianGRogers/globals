import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNativeOwner, restoreNativeOwner } from "../src/native/owner-core.js";
import { NativeReaderSource } from "../src/native/reader-core.js";

const dir = mkdtempSync(join(tmpdir(), "globals-native-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const regionPath = () => join(dir, `region-${n++}.mem`);

interface State {
  count: number;
  rows: { name: string }[];
}

const options = (path: string) => ({
  regionPath: path,
  initial: { count: 0, rows: [{ name: "first" }] } as State,
  operations: {
    increment(draft: State, payload: { by: number }) {
      draft.count += payload.by;
    },
    rename(draft: State, payload: { index: number; name: string }) {
      draft.rows[payload.index].name = payload.name;
    },
  },
});

test("the initial commit is readable through the region before any operation", () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));
  const source = NativeReaderSource.attach(path);

  assert.equal(source.version, 1, "creating the owner publishes the initial state");
  assert.deepEqual(source.snapshot().toJSON(), { count: 0, rows: [{ name: "first" }] });
  assert.equal(source.select(["rows", 0, "name"]), "first");

  source.close();
  owner.close();
});

test("a dispatched operation is visible to a reader after its promise resolves", async () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));
  const source = NativeReaderSource.attach(path);

  const before = source.version;
  await owner.dispatch("increment", { by: 3 });
  const committed = await owner.dispatch("increment", { by: 4 });

  assert.equal(source.version, before + 2);
  assert.equal(
    committed,
    source.version,
    "a dispatch resolves with the region version, the currency readers deal in",
  );
  assert.equal(source.select(["count"]), 7);

  source.close();
  owner.close();
});

test("a snapshot pins its commit while later reads see later commits", async () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));
  const source = NativeReaderSource.attach(path);

  const pinned = source.snapshot();
  await owner.dispatch("rename", { index: 0, name: "second" });

  assert.equal(source.select(["rows", 0, "name"]), "second");
  assert.equal(
    (pinned.value as State).rows[0].name,
    "first",
    "the pinned snapshot must keep reading the commit it was taken from",
  );

  source.close();
  owner.close();
});

test("an unknown operation rejects and commits nothing", async () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));
  const source = NativeReaderSource.attach(path);

  const before = source.version;
  await assert.rejects(owner.dispatch("explode", {}), /unknown operation "explode"/);
  assert.equal(source.version, before);

  source.close();
  owner.close();
});

test("notify fires subscribers once per version change, and reads never depend on it", async () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));
  const source = NativeReaderSource.attach(path);

  let fired = 0;
  const unsubscribe = source.subscribe(() => fired++);

  await owner.dispatch("increment", { by: 1 });
  assert.equal(source.select(["count"]), 1, "the read is current before any notify arrives");

  source.notify();
  source.notify();
  assert.equal(fired, 1, "a second notify with no new commit stays silent");

  unsubscribe();
  await owner.dispatch("increment", { by: 1 });
  source.notify();
  assert.equal(fired, 1, "an unsubscribed listener stays unsubscribed");

  source.close();
  owner.close();
});

test("a persisted owner rehydrates the last flushed snapshot", async () => {
  const file = join(dir, "snapshot.json");
  const persistence = { file, debounceMs: 5 };

  const first = await restoreNativeOwner({ ...options(regionPath()), persistence });
  await first.dispatch("increment", { by: 9 });
  await first.snapshots?.flush();
  first.close();

  const second = await restoreNativeOwner({ ...options(regionPath()), persistence });
  assert.equal(
    second.store.select(["count"]),
    9,
    "the rehydrated owner must start from the flushed snapshot, not the configured initial",
  );

  const source = NativeReaderSource.attach(second.regionPath);
  assert.equal(source.select(["count"]), 9, "and the region holds the rehydrated commit");
  source.close();
  second.close();
});

test("the owner reads its own store on the same contract", async () => {
  const path = regionPath();
  const owner = createNativeOwner(options(path));

  assert.deepEqual((owner.store.get() as State).count, 0);
  await owner.store.update<State>((draft) => {
    draft.count = 41;
  });
  assert.equal(owner.store.select(["count"]), 41);
  assert.equal(owner.version(), 2, "a direct store write flushes like a dispatched one");

  owner.close();
});
