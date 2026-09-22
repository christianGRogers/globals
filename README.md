# Globals

Synchronous reads of shared application state across Electron processes, on one region of
real shared memory. Published as
[`@bradensbay/globals`](https://www.npmjs.com/package/@bradensbay/globals), version 0.2.0.

The contract in two sentences. **Reads are synchronous**: `store.get()` returns the current
committed value on the line you call it, in any window, with no `await` and no round trip.
**Writes are asynchronous**: a window sends an intent, the owner applies it, and the line
after your write may still read the old value.

The trade in one sentence, first because it decides adoption: **a window that reads
synchronously runs with `sandbox: false`**, so it must render only UI you build and bundle.
Windows that keep their sandbox get an asynchronous tier instead. The full reasoning is
[docs/trust-model.md](docs/trust-model.md), and
[docs/migration.md](docs/migration.md) opens with the cases where you should not use this
at all.

## How to use it

```bash
npm install @bradensbay/globals
```

That is the whole toolchain story on the six platforms the transport ships prebuilt for:
macOS, Linux, and Windows on x64 and arm64, where nothing compiles on install. Anywhere else,
Alpine and other musl systems included, it builds from source at install time and needs a C
toolchain; if there is not one, the install still succeeds and the error at first use names
what to install.

**1. The main process is the owner.** Declare the initial state and every write any window
may request:

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

owner.store.get();                          // the owner reads its own store synchronously
await owner.update((draft) => { draft.count = 0; });
```

**2. A trusted window reads synchronously through its preload.** The window is created with
`sandbox: false` and `contextIsolation: true`, and its preload is an ES module:

```ts
// preload.mjs
import { contextBridge } from "electron";
import { connectNative } from "@bradensbay/globals/preload";

const store = await connectNative();

store.get();                                // synchronous, never stale, never torn
store.select(["rows", 3, "name"]);          // one path, no intermediate objects
await store.dispatch("increment", { by: 1 });

// Expose whole operations to the page: a bridge crossing costs about a microsecond,
// so one call should return everything a render needs.
contextBridge.exposeInMainWorld("app", {
  view: () => store.snapshot().toJSON(),
  dispatch: (operation, payload) => store.dispatch(operation, payload),
  onCommit: (listener) => store.subscribe(listener),
});
```

**3. A window that keeps its sandbox gets the asynchronous tier.** Point it at the shipped
preload and it reads by asking, with no synchronous API to misuse:

```ts
import { asyncPreloadPath } from "@bradensbay/globals";

new BrowserWindow({ webPreferences: { preload: asyncPreloadPath(), sandbox: true } });
// In that page: await globalsAsync.read(), globalsAsync.dispatch(), globalsAsync.subscribe()
```

The framework bindings, `@bradensbay/globals-react`, `-vue`, and `-svelte`, sit on the same
subscribe and snapshot pair. The [example application](examples/native-multi-window) runs
all of this on screen: two synchronous windows, one sandboxed one, one owner.

## How it achieves this

**One mapped region, one writer.** A Node-API addon maps a file-backed region into every
process. The owner in the main process is the only writer: it runs the ordinary in-process
store over a private buffer and publishes each commit into the region. Everyone else maps
the region read only, enforced by the operating system, so no window can corrupt what other
windows read.

**Readers copy one commit, then decode privately.** Every read starts with one native
version check, about 14 ns. When the version moved, the reader copies the region into a
fresh private buffer, once per commit observed, and the decoder works entirely on that
private memory. A read can never observe a stale version and never a torn one. Snapshots
pin the buffer they were taken from, so ordinary garbage collection is the whole
reclamation story.

**The region is double buffered.** The owner builds each commit in the slot the previous
commit did not publish, each slot carries its own sequence and version, and version plus
slot index publish as one atomic word. A reader's copy is torn only if the writer laps into
the same slot mid copy, which it cannot sustain, because it must complete an entire further
commit first. The transport soak that forced this design ran a writer at full rate against
four reader processes: 533,277 commits, 105,317 copies, zero torn.

**The V8 memory cage never sees foreign memory.** No JavaScript ArrayBuffer ever wraps the
mapping. The addon touches shared memory only inside native calls, and every byte the
decoder reads lives in a buffer V8 allocated.

**Why not `SharedArrayBuffer`?** Because the web platform refuses, finally: the HTML agent
cluster rule keeps shared memory inside one cluster, and clusters never span the renderer
process boundary this library exists to cross. Every mechanism was measured before this
design shipped; the record, including process ids, is in
[spikes/RESULTS.md](spikes/RESULTS.md) and
[docs/architecture.md](docs/architecture.md).

**What it costs, measured in real Electron** ([docs/benchmarks.md](docs/benchmarks.md)): a
synchronous decoded read in the preload is 253 ns against a 35 µs real `ipcRenderer.invoke`
round trip, 138 times faster. Across the contextBridge a page pays 873 ns, still 40 times
faster and synchronous. Observing a fresh commit costs about 80 µs, once per commit per
window. Continuous integration holds this on Electron 42 through 44 across all three
platforms, plus a canary on the newest prerelease.

## Documentation

Read in this order.

| Document | Why |
| --- | --- |
| [contract.md](docs/contract.md) | Everything downstream depends on it |
| [trust-model.md](docs/trust-model.md) | Decide whether this is safe for your application |
| [migration.md](docs/migration.md) | Starting with when not to switch |
| [electron.md](docs/electron.md) | The integration guide |
| [bindings.md](docs/bindings.md) | React, Vue, and Svelte |
| [api.md](docs/api.md) | The reference |
| [architecture.md](docs/architecture.md) | The topology, and the record of the one the platform refused |
| [object-layer.md](docs/object-layer.md) | What each operation costs |
| [reclamation.md](docs/reclamation.md) | How memory is freed while readers run |
| [hardening.md](docs/hardening.md) | The security note, and what is outstanding |
| [devtools.md](docs/devtools.md) | Inspection and time travel |
| [benchmarks.md](docs/benchmarks.md) | The numbers, and the harness behind them |
| [stability.md](docs/stability.md) | The supported Electron range |
| [plan.md](docs/plan.md) | The original development plan and its gates |
| [plan-native.md](docs/plan-native.md) | The successor plan: to a working library on the native transport |

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/core` | Runtime agnostic arena, encoding, persistent structures, reclamation |
| `packages/shm` | The native transport: one mapped region, a double-buffered owner, reader copies that are one commit |
| `packages/electron` | `@bradensbay/globals`: main process owner, preload readers, async tier |
| `packages/react` | The `useSyncExternalStore` binding |
| `packages/vue` | Vue adapter over the same subscribe and snapshot pair |
| `packages/svelte` | Svelte store adapter |
| `spikes` | Phase 0 feasibility spikes, throwaway by design |
| `examples` | The three window example over the native transport, two tiers |
| `benchmarks` | The reproducible harness behind the numbers in the docs |
| `docs` | Contract, trust model, architecture, and the rest |

## Development

```bash
npm install
npm run build:native
npm run build
npm test          # unit, property, corruption, and exhaustion tests
npm run soak      # multi process arena soak, the release gate for arena changes
npm run chaos     # the arena chaos harness, simulated windows in worker threads
npm run fuzz      # the decoder against deliberately corrupted arenas
npm run bench     # arena read latency, in Node
```

The transport has its own soak across real OS processes:

```bash
node packages/shm/test/soak/run-soak.mjs --readers 4 --seconds 60
```

Two checks need a real display and open windows, so they are not part of continuous
integration on this machine:

```bash
npm run gate:e2e     # nineteen checks against real windows in separate processes
npm run gate:chaos   # window lifecycle chaos, with real renderer processes
npm run gate:example # the three window example application
npm run bench:native # the read latency an application actually pays
npm run gate         # spike 01, now a verdict change detector for the closed web route
```

What each verdict means is in [spikes/README.md](spikes/README.md).

Branching follows a gitflow variant described in [docs/branching.md](docs/branching.md).
Continuous integration is described in [docs/ci.md](docs/ci.md). Work lands on `dev`. Only a
release merge reaches `main`.

## License

MIT. See [LICENSE](LICENSE).
