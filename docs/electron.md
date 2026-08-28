# Electron integration

Three processes, three entry points, and one handshake. This page is what an application
author needs; the reasoning behind the topology is in
[architecture.md](architecture.md) and [ADR 0001](adr/0001-hidden-owner-window.md).

## The shape

| Process | Entry point | Role |
| --- | --- | --- |
| Main | `prepare()` at module scope, then `GlobalsHost.start()` | Broker. Creates the owner window, hands out ports, persists state. Never touches the arena. |
| Hidden owner window | `startOwner()` | Sole writer. Allocates the arena, applies operations, publishes roots. |
| Each UI window | `connect()` | Reader. Synchronous reads, asynchronous writes through intents. |

## Main process

```ts
import { app, BrowserWindow } from "electron";
import { GlobalsHost, prepare, preloadPath } from "@globals/electron";

// Must run at module scope, before the app is ready. Electron ignores a scheme registered
// afterwards, and the symptom appears much later as a buffer that will not transfer.
prepare();

await app.whenReady();

const host = await GlobalsHost.start({
  root: join(import.meta.dirname, "renderer"),
  ownerPage: "owner.html",
  persistence: { file: join(app.getPath("userData"), "state.json") },
});

const window = new BrowserWindow({
  webPreferences: {
    preload: preloadPath(),
    sandbox: true,
    contextIsolation: true,
  },
});

host.attach(window, { name: "main-window" });
await window.loadURL(host.url("index.html"));
```

Reads from the main process are asynchronous and always will be. Node cannot map the arena,
so `host.read()` is a round trip to the owner window. The types say so at the call site.

```ts
const state = await host.read();
await host.dispatch("increment", { by: 1 });
```

## The owner window

The owner page is an ordinary bundle you write. It runs in a hidden renderer with no Node
access.

```ts
import { startOwner } from "@globals/electron";

const runtime = startOwner({
  initial: { count: 0, users: [] },
  operations: {
    increment(draft, payload: { by: number }) {
      draft.count += payload.by;
    },
    addUser(draft, payload: { name: string }) {
      draft.users.push({ name: payload.name });
    },
  },
  liveness: { intervalMs: 1000, missesBeforeDead: 5 },
});
```

Operations are named because functions cannot cross a process boundary. A window sends the
name of an operation and a payload, not a recipe. That has a second benefit worth stating:
the complete set of writes a window can request is declared in one file, so the write surface
is reviewable.

The owner can also write directly, which is how a timer, a socket, or a background task in
the owner window updates state:

```ts
runtime.update((draft) => { draft.count += 1; });
```

## A UI window

```ts
import { connect } from "@globals/electron/renderer";

const store = await connect();

if (store.tier === "shared") {
  store.get();                       // synchronous, no await
  store.select(["users", 0, "name"]); // one path, no intermediate objects
}

await store.dispatch("increment", { by: 1 });
```

`connect()` resolves once the window holds either the buffer or its first replicated value,
so a first render reads real state rather than a placeholder. Call it before mounting.

## The two tiers

A window is on the shared tier or the asynchronous tier, and the API differs on purpose.

| | Shared tier | Asynchronous tier |
| --- | --- | --- |
| Read | `store.get()`, synchronous | `await store.read()` |
| Write | `await store.dispatch(...)` | `await store.dispatch(...)` |
| Holds the buffer | Yes | No |
| Can corrupt shared state | Yes | No |

The read method has a different name in each tier. Code written against one does not
silently compile against the other, so moving a window between tiers is a decision the
compiler makes you acknowledge rather than a runtime surprise.

Decide the tier in the owner:

```ts
startOwner({
  asyncOnly: (name) => name.startsWith("untrusted-"),
  // ...
});
```

Give any window that renders content you do not control the asynchronous tier. See
[trust-model.md](trust-model.md).

## The custom protocol

`SharedArrayBuffer` transfers between renderers only when they are cross origin isolated,
and a renderer is isolated only when its document carried COOP and COEP. Electron cannot set
headers on `file://`, so the application has to be served through a scheme this library
controls.

This is the awkward part of adoption and there is no way around it that keeps the sandbox on.
An application currently loading from `file://` has to move to the custom scheme first.

A dev server is supported and is re-headed on the way through, so development does not
silently lose isolation and leave the shared tier working only in production builds:

```ts
GlobalsHost.start({
  root: join(import.meta.dirname, "renderer"),
  ownerPage: "owner.html",
  devServer: "http://localhost:5173",
});
```

## Lifecycle

| Event | What happens |
| --- | --- |
| Window opens | The host brokers a port pair, the owner sends the buffer, `connect()` resolves |
| Window reloads | The renderer heap is discarded with its port. The window asks again on load, and the abandoned reader slot is reaped by the liveness detector |
| Window closes | The reader detaches and its slot is released immediately |
| Renderer crashes | The slot stays claimed and its epoch stays pinned. The liveness detector notices the stalled heartbeat and reclaims the slot, after which retention returns to normal |
| Owner crashes | Every reader fails closed on the owner generation check. The host must restart the owner and rehydrate |

The liveness detector is deliberately patient: it declares a reader dead only after several
consecutive samples in which a pinned reader failed to move its heartbeat. Reaping a merely
slow reader costs it a `StaleSnapshotError` and a reacquire, which is recoverable but
pointless.

## Persistence

```ts
GlobalsHost.start({
  persistence: {
    file: join(app.getPath("userData"), "state.json"),
    debounceMs: 250,
  },
});
```

Writes are debounced and coalesced, written to a temporary file beside the target, and moved
into place with a rename. A crash mid write leaves either the old file or the new one, never
half of either. The temp file sits in the same directory on purpose: a rename across
filesystems is a copy, and a copy is not atomic.

A pending write is flushed on `before-quit`, because the last commit before a quit is the one
a user is most likely to notice missing.

## What the gate still owes

The buffer sharing spike has not yet been run on a machine with a display. Until it has, the
Electron integration is written against a claim rather than a measurement. See
[spikes/RESULTS.md](../spikes/RESULTS.md) for what was attempted and why it could not
complete, and the `electron-matrix` workflow for where it runs properly.
