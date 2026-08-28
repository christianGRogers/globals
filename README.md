# Globals

Synchronous reads of shared application state across Electron processes, built on one region
of real shared memory, for applications whose arena windows run without the Chromium sandbox.

> **Status: pre-release, on the native transport ([ADR 0003](docs/adr/0003-native-transport.md)).**
>
> The web platform cannot carry this design, and that result is final: a
> `SharedArrayBuffer` never crosses a renderer process boundary, by the HTML specification's
> agent cluster rule rather than by anything Electron could fix. The measurements, including
> process ids, are in [spikes/RESULTS.md](spikes/RESULTS.md).
>
> What ships instead steps outside the web platform. A Node-API addon maps one region into
> every process; the owner lives in the main process; a trusted window's preload reads it
> with a 14 ns version check and copy-on-commit, and the untouched core decodes from private
> memory. The price is the first sentence of
> [the trust model](docs/trust-model.md): **windows that read synchronously run with
> `sandbox: false`.** Windows that keep their sandbox get the asynchronous tier, and the
> region itself is mapped read only by everyone but the owner, enforced by the OS.

## The contract

**Reads are synchronous.** `store.get()` returns the current committed value on the line you
call it, in any window, with no `await` and no round trip.

**Writes are asynchronous.** A window sends an intent, the owner applies it, and every window
observes the result shortly after. The line following your write may still read the old value.

This is not a compromise imposed by the implementation. A write must be serialized against
every other write, and serialization has to happen somewhere. Readers can be given the
illusion of immediacy, writers cannot.

## The trust boundary, up front

A window that reads shared state synchronously runs without the Chromium sandbox. That is
the trade, at full strength: a compromised renderer in such a window is not a contained
process but native code running as the user. Context isolation stays on and the page gets no
Node access, but the defence against a renderer exploit is gone, so an arena window must
render only UI you build and bundle.

What did not get weaker is shared state integrity: everyone but the owner maps the region
read only, enforced by the operating system, so no window can corrupt what other windows
read. A window that must keep its sandbox uses the asynchronous tier and never maps
anything. The whole model is [docs/trust-model.md](docs/trust-model.md).

If your application loads third party content into a window that needs synchronous shared
state, this library is the wrong tool.

## Why it exists

React's `useSyncExternalStore`, Vue's reactivity, and any render path that must produce markup
synchronously all demand a snapshot *now*. Electron applications today cannot supply one
without keeping a replicated copy of state in every window. This supplies one.

Most applications do not need it. [docs/migration.md](docs/migration.md) opens with the cases
where you should not switch, because that list is longer than the one where you should.

## How fast

A shared read of a double costs 418 ns on the reference machine, against 33 microseconds for a
structured clone round trip. That is 79 times faster, and roughly 130 times the cost of a
plain local property read.

Measured through the whole stack in real Electron, over the native transport: 253 ns for the
same read in a preload against a 35 µs real `ipcRenderer.invoke` round trip, which is 138
times faster, and 873 ns when a page crosses the contextBridge for it, still 40 times faster
and synchronous.

The phase 0 spike modelled the read path and predicted 7.8 ns. The real path is slower because
it validates the version on both sides of every decode and bounds checks every offset, neither
of which is optional. The full numbers, the machine, and what was tuned are in
[docs/benchmarks.md](docs/benchmarks.md).

## A first look

```ts
// The main process is the owner. Every write any window can request is declared here.
const owner = await startNativeOwner({
  initial: { count: 0, rows: [] },
  operations: {
    increment(draft, payload: { by: number }) {
      draft.count += payload.by;
    },
  },
});

// A trusted window's preload, with sandbox: false.
const store = await connectNative();
store.get();                        // synchronous, no await
store.select(["rows", 3, "name"]);  // one path, no intermediate objects
await store.dispatch("increment", { by: 1 });
```

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
| `packages/electron` | The native transport integration: main process owner, preload readers, async tier |
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
