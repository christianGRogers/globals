# API reference

Organised by the process the code runs in, because that is what decides what is available.

## Main process, `@bradensbay/globals`

```ts
import { startNativeOwner, asyncPreloadPath, SnapshotStore } from "@bradensbay/globals";
```

| Export | Signature | Notes |
| --- | --- | --- |
| `startNativeOwner` | `(options: StartNativeOwnerOptions<State>) => Promise<NativeOwner<State>>` | Creates the region, becomes its only writer, answers window hellos and intents, pings per commit. Asynchronous because persistence may rehydrate. |
| `asyncPreloadPath` | `() => string` | The shipped preload for sandboxed windows; pass as `preload` in `webPreferences`. |
| `SnapshotStore` | class | Debounced persistence with temp file and rename discipline; `startNativeOwner` wires it when `persistence` is given. |

`NativeOwner` carries `store` (the core `OwnerStore`, synchronous reads and direct writes in
this process), `update(recipe)`, `dispatch(operation, payload)`, `version()`, `snapshots`,
and `close()`. `dispatch` and `update` resolve with the region version, the currency every
reader deals in.

## Trusted window preload, `@bradensbay/globals/preload`

Runs in a preload with `sandbox: false` and context isolation on. The page never imports
this; the preload decides what crosses the bridge.

```ts
import { connectNative } from "@bradensbay/globals/preload";
```

`connectNative()` resolves to a `NativeConnection`:

| Member | Signature | Notes |
| --- | --- | --- |
| `get` | `(): unknown` | Synchronous, never stale, never torn. |
| `select` | `(path): unknown` | One path, no intermediate objects. |
| `snapshot` | `(): Snapshot` | Pins its commit for as long as it is held. |
| `dispatch` | `(operation, payload?): Promise<number>` | Resolves with the committed region version. |
| `subscribe` | `(listener): () => void` | Driven by the owner's ping; never on the read path. |
| `version` | `number` | The live region version, one native call. |
| `close` | `(): void` | |

## Sandboxed window, `window.globalsAsync`

Loaded by `asyncPreloadPath()`. There is no synchronous read on this tier at all.

| Member | Signature | Notes |
| --- | --- | --- |
| `read` | `(path?): Promise<{ version, value }>` | The whole state, or one path of it. |
| `dispatch` | `(operation, payload?): Promise<number>` | The same intent path the shared tier uses. |
| `subscribe` | `(listener): () => void` | Called with the new version after every commit. |
| `ready` | `(): Promise<number>` | Resolves once the connection to the owner exists. |
| `tier` | `"async"` | |

## Transport, `@bradensbay/globals-shm`

```ts
import { OwnerRegion, ReaderRegion, LAYOUT_VERSION } from "@bradensbay/globals-shm";
```

| Export | Signature | Notes |
| --- | --- | --- |
| `OwnerRegion.create` | `(path, dataSize) => OwnerRegion` | The creating process is the only writer. |
| `OwnerRegion.prototype.flush` | `(src, ranges?) => number` | Publishes one commit's dirty ranges; returns the new version. |
| `ReaderRegion.attach` | `(path) => ReaderRegion` | Read only mapping, enforced by the OS; refuses foreign files and layouts. |
| `ReaderRegion.prototype.sync` | `(dest) => number` | A copy that is exactly one commit, and the version it belongs to. |
| `version` | `() => number` | One native call, the fast path before deciding to sync. |

## Core, `@bradensbay/globals-core`

Most applications never import this directly. It is what the integration and the bindings are
built on, and what to reach for when writing an integration for something other than Electron.

### Owner and reader

| Export | Notes |
| --- | --- |
| `ArenaOwner.create(options)` | Allocates and formats an arena. The sole writer. |
| `ArenaOwner.adopt(buffer)` | Takes over a buffer a previous owner formatted. Bumps the generation. |
| `owner.commit(value)` | Replaces the root. Everything the old root reached becomes garbage. |
| `owner.update(recipe)` | Rebuilds only the paths the recipe touched. |
| `owner.reclaim()` | Reclaim now, rather than at the next commit. |
| `ArenaReader.attach(buffer, options?)` | Claims a reader slot. |
| `reader.acquire()` | A pinned `Snapshot` for the current version. |
| `reader.read()` | The current value, synchronously. |
| `reader.acquireVersion(id)` | A retained version, for time travel. Suspends the current pin. |
| `reader.detach()` | Releases the slot. Always call it. |

`OwnerOptions`: `byteLength?`, `maxByteLength?`, `maxReaders?`, `retainedVersions?`, `verify?`,
`historyDepth?`.

### Snapshot

| Member | Notes |
| --- | --- |
| `snapshot.value` | A lazy view. Decodes on property access. |
| `snapshot.get(path)` | One path, no intermediate views. |
| `snapshot.toJSON()` | The whole structure, detached. Costs a full decode. |
| `snapshot.versionId` | |
| `snapshot.isValid()` | Never throws. |
| `snapshot.validate()` | Throws `StaleSnapshotError`. |
| `snapshot.release()` | Unpins. |

### Stores

`OwnerStore` and `ReaderStore` wrap the pair above with the `ReadableStore` and
`WritableStore` interfaces the bindings are written against. `ReaderStore` has no write
method at all.

### Diagnostics

| Export | Notes |
| --- | --- |
| `formatArena(owner)` | A readable report, for a console or a bug report. |
| `reportArena(owner)` | The same as data. |
| `reportReader(reader)` | Including `headroomVersions`, the number that matters. |
| `VersionHistory` | Time travel over the retained ring. Needs `historyDepth`. |
| `diffShallow(a, b)` | Top level changes between two values. |

### Errors

| Error | Meaning |
| --- | --- |
| `StaleSnapshotError` | The version you held was reclaimed. Reacquire. Expected under load. |
| `ArenaCorruptError` | A decode found something a correct writer cannot produce. A security event as well as a bug. |
| `ArenaFullError` | The arena is exhausted and cannot grow. |
| `NoReaderSlotError` | Every reader slot is claimed. |
| `UnencodableValueError` | The value is outside the type ladder. |
| `GlobalsError` | The base class, to catch all of the above. |

## Bindings

See [bindings.md](bindings.md). The short version:

| Package | Read one path | Read a container | Hold a version |
| --- | --- | --- | --- |
| `@bradensbay/globals-react` | `usePath` | `useNodeSelector` | `usePinnedSnapshot` |
| `@bradensbay/globals-vue` | `usePath` | `useNodeSelector` | `usePinnedSnapshot` |
| `@bradensbay/globals-svelte` | `path` | `selectedNode` | `pinnedSnapshot` |
