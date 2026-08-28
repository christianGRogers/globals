# Globals

Synchronous reads of shared application state across Electron processes, built on one region
of real shared memory.

> **Status: 0.1.0, pre-release.** The feasibility gate that decides whether this can work at
> all has not been cleared on a machine with a display. Read
> [docs/stability.md](docs/stability.md) and [docs/trust-model.md](docs/trust-model.md) before
> adopting it.

## The contract

**Reads are synchronous.** `store.get()` returns the current committed value on the line you
call it, in any window, with no `await` and no round trip.

**Writes are asynchronous.** A window sends an intent, the owner applies it, and every window
observes the result shortly after. The line following your write may still read the old value.

This is not a compromise imposed by the implementation. A write must be serialized against
every other write, and serialization has to happen somewhere. Readers can be given the
illusion of immediacy, writers cannot.

## The trust boundary, up front

Every window that maps the arena can write to the arena. That is a property of shared memory,
not a bug to be fixed, and it partially undoes what the renderer sandbox buys you. Three
responses, all in [docs/trust-model.md](docs/trust-model.md):

1. Every window mapping the arena is one trust domain. Treat it that way.
2. A window that renders untrusted content opts out and gets the asynchronous tier only.
3. A verified read mode checks an owner published checksum before decoding. It detects
   corruption. It does not stop a window that forges a valid checksum, and calling it a
   security control would be a claim a reviewer should reject.

If your application loads third party content into a window that needs shared state, this
library is the wrong tool.

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

The phase 0 spike modelled the read path and predicted 7.8 ns. The real path is slower because
it validates the version on both sides of every decode and bounds checks every offset, neither
of which is optional. The full numbers, the machine, and what was tuned are in
[docs/benchmarks.md](docs/benchmarks.md).

## A first look

```ts
// The hidden owner window. Every write any window can request is declared here.
startOwner({
  initial: { count: 0, rows: [] },
  operations: {
    increment(draft, payload: { by: number }) {
      draft.count += payload.by;
    },
  },
});

// Any UI window.
const store = await connect();
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
| [architecture.md](docs/architecture.md) | The topology the platform forces |
| [object-layer.md](docs/object-layer.md) | What each operation costs |
| [reclamation.md](docs/reclamation.md) | How memory is freed while readers run |
| [hardening.md](docs/hardening.md) | The security note, and what is outstanding |
| [devtools.md](docs/devtools.md) | Inspection and time travel |
| [benchmarks.md](docs/benchmarks.md) | The numbers, and the harness behind them |
| [stability.md](docs/stability.md) | The supported Electron range |
| [plan.md](docs/plan.md) | The development plan and its gates |

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/core` | Runtime agnostic arena, encoding, persistent structures, reclamation |
| `packages/electron` | Owner window, bootstrap handshake, lifecycle, main process API |
| `packages/react` | The `useSyncExternalStore` binding |
| `packages/vue` | Vue adapter over the same subscribe and snapshot pair |
| `packages/svelte` | Svelte store adapter |
| `spikes` | Phase 0 feasibility spikes, throwaway by design |
| `examples` | A four window application over five thousand shared rows |
| `benchmarks` | The reproducible harness behind the numbers in the docs |
| `docs` | Contract, trust model, architecture, and the rest |

## Development

```bash
npm install
npm run build
npm test          # unit, property, corruption, and exhaustion tests
npm run soak      # multi process soak, the release gate for arena changes
npm run chaos     # windows opened, reloaded, frozen, and killed
npm run fuzz      # the decoder against deliberately corrupted arenas
npm run bench     # read latency
```

Branching follows a gitflow variant described in [docs/branching.md](docs/branching.md).
Continuous integration is described in [docs/ci.md](docs/ci.md). Work lands on `dev`. Only a
release merge reaches `main`.

## License

MIT. See [LICENSE](LICENSE).
