# Electron integration

What an application author needs, in the order the decisions arrive. The reasoning behind
the topology is in [architecture.md](architecture.md); whether the trade is acceptable for
your application is [trust-model.md](trust-model.md), and that page comes first.

## The shape

| Process | Entry point | Role |
| --- | --- | --- |
| Main | `startNativeOwner()` | The owner. Creates the region, applies every write, persists, pings per commit. |
| Trusted window preload, `sandbox: false` | `connectNative()` | Synchronous reads over a private copy; dispatch over IPC. |
| Sandboxed window | `asyncPreloadPath()` as the preload | The asynchronous tier: reads by request, same write path. |

There is no hidden owner window, no custom protocol, and no handshake. A window needs
nothing before its first render except its preload, and the preload maps the region itself.

## Main process

```ts
import { app, BrowserWindow } from "electron";
import { startNativeOwner, asyncPreloadPath } from "@globals/electron";

app.whenReady().then(async () => {
  const owner = await startNativeOwner({
    initial: { count: 0, rows: [] },
    operations: {
      // Every write any window can request is declared here, by name. Operations are the
      // privilege boundary, exactly like your IPC handlers: validate payloads.
      increment(draft, payload: { by: number }) {
        draft.count += payload.by;
      },
    },
    persistence: {},            // optional: rehydrate on boot, save commits under userData
    byteLength: 1 << 20,        // region size, fixed for the region's life
  });

  // The owner reads and writes its own store synchronously; main is not a second-class
  // citizen in this topology.
  owner.store.get();
  await owner.update((draft) => { draft.count = 0; });
});
```

`startNativeOwner` is asynchronous because persistence may rehydrate, and startup is the one
place that wait belongs. The region file defaults to `globals.region` under `userData`;
`persistence: {}` defaults its snapshot beside it. A full arena raises `ArenaFullError`
rather than growing past what readers mapped: pick `byteLength` for your state with
headroom.

## A trusted window

```ts
new BrowserWindow({
  webPreferences: {
    preload: join(__dirname, "preload.mjs"),
    sandbox: false,            // the trade the trust model leads with
    contextIsolation: true,    // stays on; the page gets no Node access
    nodeIntegration: false,
  },
});
```

The preload is an ES module (`.mjs`, Electron 28 and later, unsandboxed windows only):

```ts
// preload.mjs
import { contextBridge } from "electron";
import { connectNative } from "@globals/electron/preload";

const store = await connectNative();

contextBridge.exposeInMainWorld("app", {
  // One crossing returns everything a render needs. A contextBridge call costs about a
  // microsecond, so the decode layer lives here and the page API is per operation, never
  // per property.
  view: () => store.snapshot().toJSON(),
  select: (path) => store.select(path),
  dispatch: (operation, payload) => store.dispatch(operation, payload),
  onCommit: (listener) => store.subscribe(listener),
});
```

The contract on the page side is the library's contract: `select` and `view` are synchronous
and can never observe a stale version or a torn one; `dispatch` resolves with the committed
version, and the line after calling it still reads the old value.

## A sandboxed window

```ts
import { asyncPreloadPath } from "@globals/electron";

new BrowserWindow({
  webPreferences: {
    preload: asyncPreloadPath(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
});
```

The page receives `window.globalsAsync`: `read(path?)` resolving `{ version, value }`,
`dispatch`, `subscribe`, `ready()`, and a `tier` of `"async"`. There is no synchronous read
on this tier at all, deliberately: an API that pretended otherwise would blur the one
distinction that matters. Use this tier for any window whose content you do not fully
control, and for any window where the sandbox matters more than a 253 ns read.

## Choosing tiers

The tier is the preload. Nothing arrives by default, and a window wired to neither has no
access of any kind. The decision rule from the trust model: a window on the shared tier is
one trust domain with your main process, so it renders only UI you build and bundle;
everything else keeps its sandbox and asks.

## Subscriptions and rendering

The owner sends one content free ping per commit. On the shared tier the ping only schedules
rerenders; the read path never waits for it, and a read between ping and render is already
current. Framework bindings sit on the same pair every tier exposes: subscribe, then read.

## Lifecycle

- **Reload**: the preload runs again, maps again, syncs, and is current before first render.
  Nothing needs cleaning up from the previous life; its buffers were private.
- **Crash**: the window's copies die with it. Nothing shared is pinned, corrupted, or
  leaked, and no other window notices. Recreate the window when you want it back.
- **The owner**: lives exactly as long as the app. Persistence flushes on `before-quit`.
- **Update across versions**: region and arena layouts are versioned; a reader from a
  different build refuses a layout it does not understand rather than misreading it. See
  [stability.md](stability.md).

## Performance expectations

From [benchmarks.md](benchmarks.md), measured through this exact stack: a preload-side
`select` of a double costs about 253 ns; the same call from the page across the bridge about
873 ns; observing a fresh commit about 80 µs once per commit per window; a real
`ipcRenderer.invoke` round trip 35 µs. Design the page API so renders cross the bridge once,
and the bridge tax stays a rounding error.

## What this page replaced

The integration this library shipped before ADR 0003, a hidden owner window, a privileged
scheme serving isolation headers, and a `window.open` handshake, was deleted when the
native transport landed. The record of that design and why the platform refused it is in
[adr/0002-window-open-handshake.md](adr/0002-window-open-handshake.md) and
[../spikes/RESULTS.md](../spikes/RESULTS.md).
