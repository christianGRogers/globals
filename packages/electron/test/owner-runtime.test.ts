import { test } from "node:test";
import assert from "node:assert/strict";

import { MARK, isOwnerToWindow } from "../src/messages.js";
import { createOwnerRuntime, type WindowLike } from "../src/owner-runtime.js";

/**
 * The owner runtime, driven through fake windows.
 *
 * The runtime takes its window opening and message listening as options for exactly this
 * reason: the handshake, the tier split, and the write surface are all testable without a
 * window manager. What is left needing Electron is whether a real SharedArrayBuffer survives
 * a real window.open, which is spike 05, and which passes.
 */

interface FakeWindow extends WindowLike {
  readonly received: unknown[];
  closed: boolean;
}

function fakeWindow(): FakeWindow {
  const received: unknown[] = [];
  return {
    received,
    closed: false,
    postMessage(message: unknown) {
      if (this.closed) throw new Error("window is gone");
      received.push(message);
    },
  };
}

interface State {
  count: number;
  items: string[];
}

function harness(asyncOnly?: (name: string) => boolean): {
  runtime: ReturnType<typeof createOwnerRuntime<State>>;
  opened: { url: string; name: string }[];
  hello: (window: FakeWindow, name: string) => void;
  send: (window: FakeWindow, message: Record<string, unknown>) => void;
  raw: (window: FakeWindow, message: unknown) => void;
} {
  let deliver: ((data: unknown, source: WindowLike | null) => void) | undefined;
  const opened: { url: string; name: string }[] = [];

  const runtime = createOwnerRuntime<State>({
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
    open: (url, name) => {
      opened.push({ url, name });
      return fakeWindow();
    },
    listen: (handler) => {
      deliver = handler;
    },
    ...(asyncOnly === undefined ? {} : { asyncOnly }),
  });

  return {
    runtime,
    opened,
    hello: (window, name) => deliver?.({ mark: MARK, kind: "hello", name }, window),
    send: (window, message) => deliver?.({ mark: MARK, ...message }, window),
    raw: (window, message) => deliver?.(message, window),
  };
}

test("a window that says hello is handed the buffer", () => {
  const { runtime, hello } = harness();
  const window = fakeWindow();
  hello(window, "main-window");

  const bind = window.received[0] as { kind: string; buffer: SharedArrayBuffer };
  assert.equal(bind.kind, "bind");
  assert.ok(bind.buffer instanceof SharedArrayBuffer);
  runtime.dispose();
});

test("every message the owner sends carries the mark", () => {
  const { runtime, hello } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  assert.ok(window.received.every((message) => isOwnerToWindow(message)));
  runtime.dispose();
});

test("unmarked traffic on the window channel is ignored", () => {
  const { runtime, raw } = harness();
  const window = fakeWindow();

  // Any page on the same origin can post to the owner. Nothing without the mark may drive it.
  raw(window, { kind: "hello", name: "impostor" });
  raw(window, "hello");
  raw(window, null);
  raw(window, { mark: "something-else", kind: "hello", name: "impostor" });

  assert.equal(window.received.length, 0, "none of that should have been answered");
  assert.equal(runtime.stats().peers, 0);
  runtime.dispose();
});

test("an opted out window is never handed the buffer", () => {
  const { runtime, hello } = harness((name) => name === "untrusted");
  const window = fakeWindow();
  hello(window, "untrusted");

  const message = window.received[0] as { kind: string; value: unknown; buffer?: unknown };
  assert.equal(message.kind, "async-only");
  assert.equal(message.buffer, undefined, "the opt out must not leak the buffer");
  assert.deepEqual(message.value, { count: 0, items: [] });
  runtime.dispose();
});

test("an intent applies a named operation and replies with the version", () => {
  const { runtime, hello, send } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  send(window, { kind: "write", id: 1, operation: "increment", payload: { by: 3 } });

  const result = window.received.find(
    (message) => (message as { kind: string }).kind === "result",
  ) as { id: number; version: number; error?: unknown };
  assert.equal(result.id, 1);
  assert.equal(result.error, undefined);
  assert.deepEqual(runtime.read(), { count: 3, items: [] });
  runtime.dispose();
});

test("an unknown operation is refused, and the message says why", () => {
  const { runtime, hello, send } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  send(window, { kind: "write", id: 7, operation: "deleteEverything", payload: null });

  const result = window.received.find((message) => (message as { id?: number }).id === 7) as {
    error: { message: string };
  };
  assert.match(result.error.message, /no operation named/);
  assert.match(result.error.message, /reviewable/);
  runtime.dispose();
});

test("an operation that throws reports it and leaves state untouched", () => {
  const { runtime, hello, send } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  send(window, { kind: "write", id: 2, operation: "increment", payload: { by: 5 } });
  send(window, { kind: "write", id: 3, operation: "explode", payload: null });

  const failure = window.received.find((message) => (message as { id?: number }).id === 3) as {
    error: { message: string };
  };
  assert.match(failure.error.message, /always fails/);
  assert.deepEqual(runtime.read(), { count: 5, items: [] });
  runtime.dispose();
});

test("a shared tier window is woken with a version notice, not the data", () => {
  const { runtime, hello } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  window.received.length = 0;

  runtime.apply("increment", { by: 1 });

  assert.ok(
    window.received.some((message) => (message as { kind: string }).kind === "version"),
    "a shared window must be told a new version exists",
  );
  assert.equal(
    window.received.some((message) => (message as { kind: string }).kind === "replica"),
    false,
    "a shared window already has the data and must not be sent it again",
  );
  runtime.dispose();
});

test("an async tier window is sent the value after every commit", () => {
  const { runtime, hello } = harness(() => true);
  const window = fakeWindow();
  hello(window, "untrusted");
  window.received.length = 0;

  runtime.apply("addItem", { label: "first" });

  const replica = window.received.find(
    (message) => (message as { kind: string }).kind === "replica",
  ) as { value: State };
  assert.deepEqual(replica.value, { count: 0, items: ["first"] });
  runtime.dispose();
});

test("several windows all observe the same commit", () => {
  const { runtime, hello } = harness();
  const first = fakeWindow();
  const second = fakeWindow();
  hello(first, "a");
  hello(second, "b");
  first.received.length = 0;
  second.received.length = 0;

  runtime.apply("increment", { by: 2 });

  for (const window of [first, second]) {
    assert.ok(window.received.some((message) => (message as { kind: string }).kind === "version"));
  }
  runtime.dispose();
});

test("a window that has gone is dropped rather than taking the owner down", () => {
  const { runtime, hello } = harness();
  const alive = fakeWindow();
  const gone = fakeWindow();
  hello(alive, "a");
  hello(gone, "b");

  gone.closed = true;
  assert.doesNotThrow(() => runtime.apply("increment", { by: 1 }));
  assert.equal(runtime.stats().peers, 1, "the closed window is forgotten");
  runtime.dispose();
});

test("the external tier serves a handle a window asks for", () => {
  const { runtime, hello, send } = harness();
  const window = fakeWindow();
  hello(window, "main-window");

  const reference = runtime.tier.put({ unencodable: () => 0 });
  send(window, { kind: "external", id: 9, handle: reference.handle });

  const result = window.received.find((message) => (message as { id?: number }).id === 9) as {
    value: { unencodable: unknown };
  };
  assert.equal(typeof result.value.unencodable, "function");
  runtime.dispose();
});

test("a fetch for an unknown external handle fails rather than returning undefined", () => {
  const { runtime, hello, send } = harness();
  const window = fakeWindow();
  hello(window, "main-window");
  send(window, { kind: "external", id: 11, handle: 4242 });

  const result = window.received.find((message) => (message as { id?: number }).id === 11) as {
    error: { message: string };
  };
  assert.match(result.error.message, /not held by this owner/);
  runtime.dispose();
});

test("openWindow asks for the window and reports whether it opened", () => {
  const { runtime, opened } = harness();
  assert.equal(runtime.openWindow("globals-app://app/ui.html", "ui-a"), true);
  assert.deepEqual(opened, [{ url: "globals-app://app/ui.html", name: "ui-a" }]);
  runtime.dispose();
});

test("stats report peers and the external tier size", () => {
  const { runtime, hello } = harness();
  hello(fakeWindow(), "a");
  hello(fakeWindow(), "b");
  runtime.tier.put("held");

  const stats = runtime.stats();
  assert.equal(stats.peers, 2);
  assert.equal(stats.external, 1);
  assert.ok(stats.versionId > 0);
  runtime.dispose();
});
