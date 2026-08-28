# Globals

Synchronous reads of shared application state across Electron processes, built on one
region of real shared memory.

> **Status: pre-release.** The feasibility gate in Phase 0 decides whether this library
> can exist on a given Electron version. Read [docs/contract.md](docs/contract.md) and
> [docs/trust-model.md](docs/trust-model.md) before adopting it.

## The contract

**Reads are synchronous.** `store.get()` returns the current committed value on the line
you call it, in any window, with no `await` and no round trip.

**Writes are asynchronous.** A window sends an intent, the owner applies it, and every
window observes the result shortly after. The line following your write may still read the
old value.

This is not a compromise imposed by the implementation. A write must be serialized against
every other write, and serialization has to happen somewhere. Readers can be given the
illusion of immediacy, writers cannot.

## Why it matters

React's `useSyncExternalStore`, Vue's reactivity, and any render path that must produce
markup synchronously all demand a snapshot *now*. Electron applications today cannot supply
one without keeping a replicated copy of state in every window. This library supplies one.

## The trust boundary, up front

Every window that maps the arena can write to the arena. That is a property of shared
memory, not a bug to be fixed, and it partially undoes what the renderer sandbox buys you.
Three responses, all documented in [docs/trust-model.md](docs/trust-model.md):

1. Every window mapping the arena is one trust domain. Treat it that way.
2. A window that renders untrusted content opts out and gets the asynchronous tier only.
3. A verified read mode checks an owner published checksum before decoding.

If your application loads third party content into a window that needs shared state, this
library is the wrong tool.

## How fast

A shared read of a double costs 431 ns on the reference machine, against 36 microseconds for
a structured clone round trip. That is 84 times faster, and roughly 120 times the cost of a
plain local property read.

The phase 0 spike modelled the read path and predicted 7.8 ns. The real path is slower
because it validates the version on both sides of every decode and bounds checks every
offset, neither of which is optional. The full numbers, the machine, and what was tuned are
in [docs/benchmarks.md](docs/benchmarks.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/core` | Runtime agnostic arena, encoding, persistent structures, reclamation |
| `packages/electron` | Owner window, bootstrap handshake, lifecycle, main process API |
| `packages/react` | `useSyncExternalStore` binding |
| `packages/vue` | Vue adapter over the same subscribe and snapshot pair |
| `packages/svelte` | Svelte store adapter |
| `spikes` | Phase 0 feasibility spikes, throwaway by design |
| `benchmarks` | The reproducible harness behind the numbers in the docs |
| `docs` | Contract, architecture, trust model, object layer, reclamation, decision records |

## Development

```bash
npm install
npm run build
npm test
```

Continuous integration is described in [docs/ci.md](docs/ci.md). Branching follows a
gitflow variant described in [docs/branching.md](docs/branching.md).
Work lands on `dev`. Only a release merge reaches `main`.

## License

MIT. See [LICENSE](LICENSE).
