# @bradensbay/globals

The Electron integration for [Globals](https://github.com/christianGRogers/globals) over the
native transport ([ADR 0003](../../docs/adr/0003-native-transport.md)): the owner is a plain
object in the main process, trusted windows map one shared memory region from their preloads
and read synchronously, and windows that keep their sandbox get the asynchronous tier.

The trade, first: **a window that maps the region runs with `sandbox: false`.** Context
isolation stays on and the page gets no Node access, but the Chromium OS sandbox for that
renderer is off. A window that must keep its sandbox uses the asynchronous tier and never
maps anything.

## Main process

```ts
import { startNativeOwner } from "@bradensbay/globals";

const owner = await startNativeOwner({
  initial: { count: 0, rows: [] },
  operations: {
    increment(draft, payload: { by: number }) {
      draft.count += payload.by;
    },
  },
  persistence: {}, // optional: rehydrate on boot, save commits under userData
});

owner.store.get();                 // the owner reads its own store synchronously
await owner.update((draft) => …);  // or writes it directly
```

## A trusted window's preload, with `sandbox: false`

```ts
import { connectNative } from "@bradensbay/globals/preload";

const store = await connectNative();
store.get();                        // synchronous, never stale, never torn
store.select(["rows", 3, "name"]);
await store.dispatch("increment", { by: 1 });
```

Expose whole operations to the page through `contextBridge`, not per-property reads: a
bridge crossing costs about a microsecond, so the decode layer belongs on the preload side.
The [example application](../../examples/native-multi-window) shows the shape.

## A sandboxed window

```ts
// main process
import { asyncPreloadPath } from "@bradensbay/globals";
new BrowserWindow({ webPreferences: { preload: asyncPreloadPath(), sandbox: true } });
```

The page receives `window.globalsAsync`: `read(path?)`, `dispatch(operation, payload)`, and
`subscribe(listener)`. There is no synchronous `get` on this tier, deliberately.

Full guide: [docs/electron.md](../../docs/electron.md).
