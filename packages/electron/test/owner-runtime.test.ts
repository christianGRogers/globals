import { test } from "node:test";
import assert from "node:assert/strict";

import { createOwnerRuntime, type MessagePortLike } from "../src/owner-runtime.js";

/**
 * The owner runtime, driven through fake ports.
 *
 * The runtime is written against a structural port type rather than the DOM MessagePort for
 * exactly this reason: the intent protocol, the tier split, and the write surface are all
 * testable without a window manager. What is left needing Electron is the handshake and the
 * lifecycle, which the chaos harness covers.
 */

interface FakePair {
  ownerSide: MessagePortLike;
  windowSide: {
    send(message: unknown): void;
    received: unknown[];
    onMessage(listener: (message: unknown) => void): void;
  };
}

function fakePorts(): FakePair {
  const ownerListeners: ((event: { data: unknown }) => void)[] = [];
  const windowListeners: ((message: unknown) => void)[] = [];
  const received: unknown[] = [];
  let closed = false;

  const ownerSide: MessagePortLike = {
    postMessage(message) {
      if (closed) return;
      received.push(message);
      for (const listener of windowListeners) listener(message);
    },
    addEventListener(_type, listener) {
      ownerListeners.push(listener);
    },
    start() {
      // Nothing to buffer in a fake.
    },
    close() {
      closed = true;
    },
  };

  return {
    ownerSide,
    windowSide: {
      send(message) {
        for (const listener of ownerListeners) listener({ data: message });
      },
      received,
      onMessage(listener) {
        windowListeners.push(listener);
      },
    },
  };
}

interface State {
  count: number;
  items: string[];
}

function runtime(asyncOnly?: (name: string) => boolean) {
  return createOwnerRuntime<State>({
    initial: { count: 0, items: [] },
    operations: {
      increment(draft: State, payload: { by: number }) {
        draft.count += payload.by;
      },
      addItem(draft: State, payload: { label: string }) {
        draft.items.push(payload.label);
      },
      explode() {
        throw new Error("this operation always fails");
      },
    } as never,
    arena: { byteLength: 1 << 18, maxByteLength: 1 << 22, maxReaders: 8, retainedVersions: 32 },
    liveness: { intervalMs: 60_000 },
    ...(asyncOnly === undefined ? {} : { asyncOnly }),
  });
}

test("a shared tier window is handed the buffer on bind", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  const bind = windowSide.received[0] as { kind: string; buffer: SharedArrayBuffer };
  assert.equal(bind.kind, "bind");
  assert.ok(bind.buffer instanceof SharedArrayBuffer);
  owner.dispose();
});

test("an opted out window is never handed the buffer", () => {
  const owner = runtime((name) => name === "untrusted");
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "untrusted");

  const message = windowSide.received[0] as { kind: string; value: unknown; buffer?: unknown };
  assert.equal(message.kind, "async-only");
  assert.equal(message.buffer, undefined, "the opt out must not leak the buffer");
  assert.deepEqual(message.value, { count: 0, items: [] });
  owner.dispose();
});

test("an intent applies a named operation and replies with the version", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  windowSide.send({ kind: "write", id: 1, operation: "increment", payload: { by: 3 } });

  const result = windowSide.received.find(
    (message) => (message as { kind: string }).kind === "result",
  ) as { id: number; version: number; error?: unknown };
  assert.equal(result.id, 1);
  assert.equal(result.error, undefined);
  assert.deepEqual(owner.read(), { count: 3, items: [] });
  owner.dispose();
});

test("an unknown operation is refused, and the message says why", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  windowSide.send({ kind: "write", id: 7, operation: "deleteEverything", payload: null });

  const result = windowSide.received.find(
    (message) => (message as { kind: string; id?: number }).id === 7,
  ) as { error: { message: string } };
  assert.match(result.error.message, /no operation named/);
  assert.match(result.error.message, /reviewable/);
  owner.dispose();
});

test("an operation that throws reports the failure and leaves state untouched", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  windowSide.send({ kind: "write", id: 2, operation: "increment", payload: { by: 5 } });
  windowSide.send({ kind: "write", id: 3, operation: "explode", payload: null });

  const failure = windowSide.received.find(
    (message) => (message as { id?: number }).id === 3,
  ) as { error: { message: string } };
  assert.match(failure.error.message, /always fails/);
  assert.deepEqual(owner.read(), { count: 5, items: [] });
  owner.dispose();
});

test("a shared tier window is woken with a version notice, not the data", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");
  windowSide.received.length = 0;

  owner.apply("increment", { by: 1 });

  const notice = windowSide.received.find(
    (message) => (message as { kind: string }).kind === "version",
  ) as { kind: string; version: number };
  assert.ok(notice, "a shared window must be told a new version exists");
  assert.equal(
    windowSide.received.some((message) => (message as { kind: string }).kind === "replica"),
    false,
    "a shared window already has the data and must not be sent it again",
  );
  owner.dispose();
});

test("an async tier window is sent the value after every commit", () => {
  const owner = runtime(() => true);
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "untrusted");
  windowSide.received.length = 0;

  owner.apply("addItem", { label: "first" });

  const replica = windowSide.received.find(
    (message) => (message as { kind: string }).kind === "replica",
  ) as { value: State };
  assert.deepEqual(replica.value, { count: 0, items: ["first"] });
  owner.dispose();
});

test("several windows all observe the same commit", () => {
  const owner = runtime();
  const first = fakePorts();
  const second = fakePorts();
  owner.bind(first.ownerSide, "a");
  owner.bind(second.ownerSide, "b");
  first.windowSide.received.length = 0;
  second.windowSide.received.length = 0;

  owner.apply("increment", { by: 2 });

  for (const side of [first.windowSide, second.windowSide]) {
    assert.ok(
      side.received.some((message) => (message as { kind: string }).kind === "version"),
      "every bound window is notified",
    );
  }
  owner.dispose();
});

test("the external tier serves a handle a window asks for", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  const reference = owner.tier.put({ unencodable: () => 0 });
  windowSide.send({ kind: "external", id: 9, handle: reference.handle });

  const result = windowSide.received.find(
    (message) => (message as { id?: number }).id === 9,
  ) as { value: { unencodable: unknown } };
  assert.equal(typeof result.value.unencodable, "function");
  owner.dispose();
});

test("a fetch for an unknown external handle fails rather than returning undefined", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");

  windowSide.send({ kind: "external", id: 11, handle: 4242 });

  const result = windowSide.received.find(
    (message) => (message as { id?: number }).id === 11,
  ) as { error: { message: string } };
  assert.match(result.error.message, /not held by this owner/);
  owner.dispose();
});

test("a message that is not an intent is ignored rather than acted on", () => {
  const owner = runtime();
  const { ownerSide, windowSide } = fakePorts();
  owner.bind(ownerSide, "main-window");
  const before = windowSide.received.length;

  windowSide.send({ kind: "write" });
  windowSide.send({ operation: "increment", payload: { by: 1 } });
  windowSide.send("increment");
  windowSide.send(null);

  assert.equal(windowSide.received.length, before, "nothing should have been replied to");
  assert.deepEqual(owner.read(), { count: 0, items: [] });
  owner.dispose();
});

test("stats report peers and the external tier size", () => {
  const owner = runtime();
  owner.bind(fakePorts().ownerSide, "a");
  owner.bind(fakePorts().ownerSide, "b");
  owner.tier.put("held");

  const stats = owner.stats();
  assert.equal(stats.peers, 2);
  assert.equal(stats.external, 1);
  assert.ok(stats.versionId > 0);
  owner.dispose();
});
