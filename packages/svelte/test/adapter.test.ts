import { test } from "node:test";
import assert from "node:assert/strict";

import { OwnerStore, ReaderStore } from "@globals/core";

import { globalState, path, pinnedSnapshot, selected, selectedNode, version } from "../src/index.js";

/**
 * The Svelte adapter, tested against the store contract rather than against a rendered
 * component.
 *
 * Svelte's store contract is one method, so testing it directly is testing all of it. The
 * same subscribe and snapshot pair backs the React and Vue bindings, so what is verified
 * here about notification behaviour holds for those too.
 */

interface State {
  count: number;
  user: { name: string };
  rows: number[];
}

function setup(): { owner: OwnerStore; reader: ReaderStore } {
  const owner = OwnerStore.create(
    { count: 0, user: { name: "first" }, rows: [1, 2, 3] },
    { byteLength: 1 << 20, maxByteLength: 1 << 24, maxReaders: 8, retainedVersions: 32 },
  );
  const reader = new ReaderStore(owner.buffer);
  // The owner store notifies its own listeners. A window is notified by the integration, so
  // in a test the two are wired directly.
  owner.subscribe(() => reader.notify());
  return { owner, reader };
}

test("a readable calls back immediately with the current value", () => {
  const { owner, reader } = setup();
  const seen: unknown[] = [];
  const stop = globalState<State>(reader).subscribe((value) => seen.push(value));

  assert.equal(seen.length, 1, "the contract is that subscribe runs immediately");
  assert.equal((seen[0] as State).count, 0);
  stop();
  owner.close();
  reader.close();
});

test("a readable is called again after a commit", async () => {
  const { owner, reader } = setup();
  const seen: number[] = [];
  const stop = selected(reader, (state) => (state as State).count).subscribe((value) =>
    seen.push(value),
  );

  await owner.update((draft: State) => {
    draft.count = 5;
  });

  assert.deepEqual(seen, [0, 5]);
  stop();
  owner.close();
  reader.close();
});

test("a selector does not notify when its slice did not change", async () => {
  const { owner, reader } = setup();
  const seen: number[] = [];
  const stop = selected(reader, (state) => (state as State).count).subscribe((value) =>
    seen.push(value),
  );

  await owner.update((draft: State) => {
    draft.user.name = "second";
  });
  await owner.update((draft: State) => {
    draft.rows[0] = 99;
  });

  assert.deepEqual(seen, [0], "an unrelated write must not wake a selector");
  stop();
  owner.close();
  reader.close();
});

test("a container selector notifies on every commit under the default equality", async () => {
  const { owner, reader } = setup();
  const seen: unknown[] = [];
  const stop = selected(reader, (state) => (state as State).user).subscribe((value) =>
    seen.push(value),
  );

  await owner.update((draft: State) => {
    draft.count = 1;
  });
  await owner.update((draft: State) => {
    draft.count = 2;
  });

  // Each commit builds a fresh decode cache, so the view is a new proxy even though the
  // subtree did not move. Object.is is the wrong question to ask about a container, and the
  // adapter does not pretend otherwise.
  assert.equal(seen.length, 3);
  stop();
  owner.close();
  reader.close();
});

test("selectedNode compares the arena node, so an untouched subtree does not notify", async () => {
  const { owner, reader } = setup();
  const seen: unknown[] = [];
  const stop = selectedNode(reader, (state) => (state as State).user).subscribe((value) =>
    seen.push(value),
  );

  await owner.update((draft: State) => {
    draft.count = 1;
  });
  await owner.update((draft: State) => {
    draft.count = 2;
  });

  assert.equal(seen.length, 1, "structural sharing kept the node, so nothing changed");

  await owner.update((draft: State) => {
    draft.user.name = "second";
  });
  assert.equal(seen.length, 2, "touching the subtree must notify");
  assert.equal((seen[1] as { name: string }).name, "second");

  stop();
  owner.close();
  reader.close();
});

test("a path readable notifies only when that path changes", async () => {
  const { owner, reader } = setup();
  const seen: unknown[] = [];
  const stop = path(reader, ["user", "name"]).subscribe((value) => seen.push(value));

  await owner.update((draft: State) => {
    draft.count = 1;
  });
  await owner.update((draft: State) => {
    draft.user.name = "changed";
  });

  assert.deepEqual(seen, ["first", "changed"]);
  stop();
  owner.close();
  reader.close();
});

test("the version readable tracks commits", async () => {
  const { owner, reader } = setup();
  const seen: number[] = [];
  const stop = version(reader).subscribe((value) => seen.push(value));

  await owner.update((draft: State) => {
    draft.count = 1;
  });

  assert.equal(seen.length, 2);
  assert.ok((seen[1] as number) > (seen[0] as number));
  stop();
  owner.close();
  reader.close();
});

test("a pinned snapshot readable releases the previous pin on each commit", async () => {
  const { owner, reader } = setup();
  const seen: { versionId: number }[] = [];
  const stop = pinnedSnapshot(reader).subscribe((snapshot) => seen.push(snapshot));

  await owner.update((draft: State) => {
    draft.count = 1;
  });
  await owner.update((draft: State) => {
    draft.count = 2;
  });

  assert.equal(seen.length, 3);
  // Only the newest pin survives, so the writer can reclaim everything behind it.
  assert.equal(reader.reader.stats().pinnedEpoch, seen[2]?.versionId);
  stop();
  owner.close();
  reader.close();
});

test("unsubscribing releases the pin, so a component leaving does not hold memory", async () => {
  const { owner, reader } = setup();
  const stop = pinnedSnapshot(reader).subscribe(() => undefined);
  assert.notEqual(reader.reader.stats().pinnedEpoch, 0);

  stop();
  assert.equal(reader.reader.stats().pinnedEpoch, 0);

  for (let i = 0; i < 50; i += 1) {
    await owner.update((draft: State) => {
      draft.count = i;
    });
  }
  assert.equal(owner.owner.stats().minimumPinnedEpoch, 0);
  owner.close();
  reader.close();
});

test("unsubscribing stops the callbacks", async () => {
  const { owner, reader } = setup();
  const seen: number[] = [];
  const stop = selected(reader, (state) => (state as State).count).subscribe((value) =>
    seen.push(value),
  );
  stop();

  await owner.update((draft: State) => {
    draft.count = 9;
  });

  assert.deepEqual(seen, [0]);
  owner.close();
  reader.close();
});
