import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SnapshotStore } from "../src/persistence.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "globals-persist-"));
}

test("a missing file is not an error, because a first run has nothing to rehydrate", async () => {
  const dir = await scratch();
  const store = new SnapshotStore({ file: join(dir, "state.json") });
  assert.equal(await store.load(), undefined);
});

test("a saved value round trips through load", async () => {
  const dir = await scratch();
  const file = join(dir, "state.json");
  const store = new SnapshotStore({ file, debounceMs: 0 });

  store.save({ count: 7, items: ["a", "b"] }, 42);
  await store.flush();

  const loaded = await new SnapshotStore({ file }).load();
  assert.deepEqual(loaded, { value: { count: 7, items: ["a", "b"] }, version: 42 });
});

test("saves are coalesced, so a fast writer does not produce a write per commit", async () => {
  const dir = await scratch();
  const store = new SnapshotStore({ file: join(dir, "state.json"), debounceMs: 5 });

  for (let i = 0; i < 500; i += 1) store.save({ i }, i);
  await store.flush();

  assert.equal(store.writeCount, 1, "five hundred commits should produce one write");
  const loaded = await store.load();
  assert.equal((loaded?.value as { i: number }).i, 499, "the last value is the one that matters");
});

test("the temp file is removed, so a directory does not fill with debris", async () => {
  const dir = await scratch();
  const store = new SnapshotStore({ file: join(dir, "state.json"), debounceMs: 0 });

  for (let i = 0; i < 5; i += 1) {
    store.save({ i }, i);
    await store.flush();
  }

  const entries = await readdir(dir);
  assert.deepEqual(entries, ["state.json"]);
});

test("a corrupt file is reported and treated as missing, rather than stopping the app", async () => {
  const dir = await scratch();
  const file = join(dir, "state.json");
  await writeFile(file, "{ this is not json", "utf8");

  const errors: unknown[] = [];
  const store = new SnapshotStore({ file, onError: (error) => errors.push(error) });

  assert.equal(await store.load(), undefined);
  assert.equal(errors.length, 1, "the failure is reported rather than swallowed");
});

test("a file from an unknown format version is treated as missing", async () => {
  const dir = await scratch();
  const file = join(dir, "state.json");
  await writeFile(file, JSON.stringify({ format: 99, value: { a: 1 } }), "utf8");
  assert.equal(await new SnapshotStore({ file }).load(), undefined);
});

test("the parent directory is created if it does not exist", async () => {
  const dir = await scratch();
  const file = join(dir, "nested", "deeper", "state.json");
  const store = new SnapshotStore({ file, debounceMs: 0 });

  store.save({ ok: true }, 1);
  await store.flush();

  assert.equal(JSON.parse(await readFile(file, "utf8")).value.ok, true);
});

test("a custom serialiser and parser are honoured", async () => {
  const dir = await scratch();
  const file = join(dir, "state.txt");
  const store = new SnapshotStore({
    file,
    debounceMs: 0,
    serialise: (value, version) => `${version}|${String(value)}`,
    deserialise: (text) => {
      const separator = text.indexOf("|");
      return { version: Number(text.slice(0, separator)), value: text.slice(separator + 1) };
    },
  });

  store.save("plain text state", 3);
  await store.flush();

  assert.equal(await readFile(file, "utf8"), "3|plain text state");
  assert.deepEqual(await store.load(), { version: 3, value: "plain text state" });
});

test("flush with nothing queued resolves without writing", async () => {
  const dir = await scratch();
  const store = new SnapshotStore({ file: join(dir, "state.json") });
  await store.flush();
  assert.equal(store.writeCount, 0);
});

test("a save that fails is reported and does not reject the caller", async () => {
  const errors: unknown[] = [];
  // A path whose parent is a file, not a directory, so mkdir fails.
  const dir = await scratch();
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory", "utf8");

  const store = new SnapshotStore({
    file: join(blocker, "state.json"),
    debounceMs: 0,
    onError: (error, phase) => errors.push({ error, phase }),
  });

  store.save({ a: 1 }, 1);
  await store.flush();

  assert.equal(store.writeCount, 0);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { phase: string }).phase, "save");
});
