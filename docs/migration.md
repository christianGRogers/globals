# Migration

Moving from a message passing store, and the cases where you should not.

## When not to switch

This section is first on purpose. Most Electron applications should stay where they are.

**You are not willing to run your UI windows with `sandbox: false`.** This is the first
entry because it decides alone. A window that reads shared state synchronously runs without
the Chromium sandbox, which is the trade [trust-model.md](trust-model.md) opens with. If
that sentence does not survive your threat model, stop here; the asynchronous tier keeps
the sandbox but is not what you came for.

**Your state is small and your windows are few.** Two windows sharing a settings object do
not need shared memory. A replicated copy costs kilobytes and a message per change, and the
whole apparatus here buys you nothing.

**You never read state during a render.** The problem this library solves is a render path
that needs a value now. If your components read from a replicated local copy that is already
in memory, you already have a synchronous read. Ours is faster to keep in sync, not faster to
read.

**You load content you do not control into windows that need the state.** Those windows
belong on the asynchronous tier with their sandbox intact, and if most of your windows are
like that, the shared tier is not buying you much.

**You need durable undo, or state larger than memory.** This is a shared snapshot of live
state, not a database. Retention is bounded and history is a debugging aid.

Switch when a window has to render a large amount of shared state and the replication is
what hurts: the memory of N copies, the cost of applying patches per window, or the first
paint of a new window waiting on a state transfer.

## What changes

| Message passing store | This library |
| --- | --- |
| Each window holds a replicated copy it must patch | A private copy refreshed by one memcpy per commit observed |
| A new window waits for a state transfer | A new window maps the region and syncs before its first render |
| Sync arrives when the message does | Reads can never observe a stale version: a 14 ns check per read |
| Writes are asynchronous | Writes are asynchronous, unchanged |
| State lives in the main process | State lives in the main process, unchanged |
| Windows keep the sandbox | Windows that read synchronously give it up; the rest keep it |

The write side barely changes. If you already dispatch named actions and await them, that
code moves across almost unaltered.

## From a Redux style main process store

Before:

```ts
// main
const store = createStore(reducer);
ipcMain.handle("dispatch", (_event, action) => {
  store.dispatch(action);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("state", store.getState());
  }
});

// renderer
const [state, setState] = useState(initial);
useEffect(() => ipcRenderer.on("state", (_e, next) => setState(next)), []);
```

After:

```ts
// owner window
startOwner({
  initial,
  operations: {
    // One function per action type. The reducer switch becomes named operations, which is
    // the same information with the dispatch table made explicit.
    increment(draft, payload: { by: number }) {
      draft.count += payload.by;
    },
  },
});

// UI window
const store = await connect();
const count = usePath<number>(["count"]);
await store.dispatch("increment", { by: 1 });
```

Three differences worth naming:

1. **A reducer returns new state, an operation mutates a draft.** The draft records what you
   touched and rebuilds only those paths, which is what keeps a write cheap. Returning a
   whole new object from an operation does not work and does not compile.
2. **Actions become named operations.** A window sends a name and a payload, because a
   function cannot cross a process boundary. The upside is that the complete set of writes a
   window can request is declared in one file.
3. **State moves out of the main process.** Main process reads become asynchronous, which is
   the change most likely to surprise you. See below.

## The main process

The awkward part of the migration. Node cannot map the arena, so anything in the main process
reads over IPC:

```ts
const state = await host.read();
await host.dispatch("increment", { by: 1 });
```

If your main process reads state synchronously in a menu handler, a protocol handler, or a
tray callback, those all become asynchronous. There is no way around it, and the types make
it a compile error rather than a runtime surprise.

A common pattern that helps: keep the small amount of state the main process actually needs,
such as window bounds or a menu enabled flag, in the main process as it is today, and put
only the state that windows render into the shared tier.

## Migrating incrementally

You do not have to move everything at once.

1. Serve your application over the custom protocol and confirm `crossOriginIsolated` is true
   in every window. Nothing else changes yet, and this is the step most likely to require
   work in your build.
2. Stand up the owner window with the slice of state that hurts most, usually the largest
   list. Leave the rest in your existing store.
3. Move one window to reading that slice from the shared tier. Both stores coexist.
4. Repeat per slice, in order of how much the replication costs you.

Step 1 is the one to do first and alone. If it does not work in your application, nothing
after it matters, and you will have spent an afternoon rather than a fortnight.

## Checking it is worth it before you commit

Run the benchmark on your own machine, and be sceptical about the ratio:

```bash
npm run bench
```

The number that decides this is not the read latency. It is how much state you are
replicating and how often it changes. If a window holds fifty megabytes of replicated rows
and rerenders on every patch, the case is easy. If it holds a settings object, there is no
case.
