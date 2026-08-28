# API reference

Organised by the process the code runs in, because that is what decides what is available.

## Main process, `@globals/electron`

```ts
import { GlobalsHost, prepare, preloadPath } from "@globals/electron";
```

| Export | Signature | Notes |
| --- | --- | --- |
| `prepare` | `(scheme?: string) => void` | Call at module scope, before the app is ready. Electron ignores a scheme registered later. |
| `GlobalsHost.start` | `(options: HostOptions) => Promise<GlobalsHost>` | Creates the owner window and starts serving the scheme. |
| `host.attach` | `(window, { name? }) => void` | Call before the window loads. The name is what the owner uses to decide the tier. |
| `host.url` | `(page: string) => string` | The URL for a page under the served root. |
| `host.read` | `() => Promise<unknown>` | Asynchronous, permanently. Node cannot map the arena. |
| `host.dispatch` | `(operation, payload?) => Promise<number>` | Resolves when the write is observable. |
| `host.restore` | `() => Promise<{ value, version } \| undefined>` | The persisted state, for the owner page to start from. |
| `host.flush` | `() => Promise<void>` | Write any debounced persistence now. |
| `preloadPath` | `() => string` | Pass as `preload` in `webPreferences`. |

`HostOptions`: `root`, `ownerPage`, `scheme?`, `devServer?`, `persistence?`, `onWindowBound?`.

## Owner window, `@globals/electron`

```ts
import { startOwner } from "@globals/electron";
```

| Export | Signature | Notes |
| --- | --- | --- |
| `startOwner` | `(options: StartOwnerOptions<State>) => OwnerRuntime<State>` | Throws when the window is not cross origin isolated. |
| `runtime.update` | `(recipe: (draft: State) => void) => number` | Synchronous here, because this process owns the arena. |
| `runtime.set` | `(value: State) => number` | Replaces the root outright. |
| `runtime.apply` | `(operation, payload) => number` | As if a window had asked. |
| `runtime.read` | `() => unknown` | A detached plain value. |
| `runtime.stats` | `() => OwnerStats & { peers, reaped, external }` | |
| `runtime.tier` | `ExternalTier` | The asynchronous escape hatch. |

`StartOwnerOptions`: `initial`, `operations`, `arena?`, `liveness?`, `onCommit?`, `asyncOnly?`.

## UI window, `@globals/electron/renderer`

```ts
import { connect, diagnose } from "@globals/electron/renderer";
```

`connect()` resolves to a `SharedConnection` or an `AsyncConnection`. The read method differs
between them on purpose, so code written for one does not silently compile against the other.

| Shared tier | Async tier |
| --- | --- |
| `get(): unknown` | `read(): Promise<unknown>` |
| `select(path): unknown` | not available |
| `snapshot(): Snapshot` | not available |
| `reader`, `buffer` | not available |
| `dispatch(operation, payload?): Promise<number>` | same |
| `external(handle): Promise<unknown>` | same |
| `subscribe(listener): () => void` | same |
| `version: number` | same |

`diagnose()` returns a readable reason the shared tier is unavailable, or `undefined`.

## Core, `@globals/core`

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
| `@globals/react` | `usePath` | `useNodeSelector` | `usePinnedSnapshot` |
| `@globals/vue` | `usePath` | `useNodeSelector` | `usePinnedSnapshot` |
| `@globals/svelte` | `path` | `selectedNode` | `pinnedSnapshot` |
