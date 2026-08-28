# Development plan

> This plan ran its course: the P0 gate failed, finally, and spike 08 measured the route
> forward. The successor is [plan-native.md](plan-native.md), implementing
> [ADR 0003](adr/0003-native-transport.md). This document stays as the record of the gates
> and the off ramps that led there.

Estimates are focused engineering weeks, not calendar time. Phases are ordered because each
depends on the one before it, and gated because at least two of them can legitimately end
the project. Every gate is a written pass or fail condition, not a judgement made
afterwards.

## P0 Feasibility spikes, 2 to 3 weeks

Answer whether the library can exist at all. Throwaway code, real measurements. Nothing
from this phase ships.

- Share a buffer. One `SharedArrayBuffer` allocated in a hidden window, readable and
  writable from two visible windows, with `sandbox: true` and `contextIsolation: true`
  intact. Serve the application over a custom protocol setting COOP and COEP, and confirm
  `crossOriginIsolated` is true.
- Verify atomics cross processes, not merely worker threads in one process. A two process
  torture test that would detect broken memory ordering.
- Verify growth. A growable buffer resized with `grow()` is observed by every process that
  already holds it. If not, size is fixed at bootstrap and the design needs a rehandshake
  path.
- Measure. Shared memory read latency against `ipcRenderer.invoke` and against a plain local
  object. The numbers become the benchmark table.
- Confirm the cage. Demonstrate that `napi_create_external_arraybuffer` over `mmap` copies
  rather than shares, so the addon route is closed on the record.

**Gate, stop the project if any of these fail.** A buffer cannot reach a sandboxed renderer
without disabling the sandbox. Or reads are less than roughly 50 times faster than an IPC
round trip, in which case the complexity buys nothing. Or atomics do not hold across
processes, in which case there is no safe protocol to build.

## P1 The arena, 4 to 6 weeks

A runtime agnostic core, testable in plain Node with worker threads, with no Electron
dependency at all. This is the part that must be correct.

- Value encoding. Tagged slots. The type ladder starts at number, string, boolean, null,
  and undefined.
- String and key interning. Append only tables owned by versions, so equal keys cost one
  slot and comparison is an integer compare.
- Allocator. Size class slabs above a bump region. Single writer means no allocator locking,
  a simplification worth defending against future feature creep.
- Epoch reclamation. Per reader epoch slots, a retained version ring, reclamation when the
  minimum epoch advances. A hard cap on retained versions with defined overflow behaviour.
- Test harness. Property based round trip tests, and a multi process soak running a writer
  at full rate against N readers for hours, asserting zero inconsistent reads. This harness
  outlives the phase and gates every later release.

**Exit.** Twenty four hours of soak with eight readers, zero inconsistent reads, zero
unbounded memory growth, and a documented worst case reclamation lag.

## P2 The object layer, 4 to 6 weeks

Turn the byte arena into something that feels like ordinary JavaScript state.

- Persistent structures. A HAMT for objects and maps, a chunked persistent vector for
  arrays, so structural sharing keeps write cost logarithmic.
- Write API. A `produce` style draft in the owner that records changes and commits one new
  root atomically.
- Read API. `getSnapshot()` returns a lazy proxy that decodes on property access, memoizing
  decoded nodes per version and dropping the cache when the root moves.
- Type ladder. Plain objects and arrays, then `Date`, `Map`, `Set`, `RegExp`, `BigInt`, and
  typed arrays. Decide explicitly on cycles, which are representable via offsets but
  complicate reclamation.
- The escape hatch. Values that cannot be encoded go to an asynchronous replicated tier
  reached through a visibly different API.

**Exit.** A realistic state shape, a few thousand records with nested objects and arrays,
round trips identically, and a single field write allocates a bounded number of nodes rather
than copying the tree.

## P3 Electron integration, 3 to 4 weeks

Make it survive real window lifecycles, which is where this class of library usually dies.

- Bootstrap. Owner window creation, the custom protocol with COOP and COEP, and a handshake
  that hands each new window a port and the buffer before its first render.
- Lifecycle. Reload, crash, close, and the second window opened an hour later. Reload in
  particular discards a renderer heap while its epoch slot is still claimed.
- Liveness. Heartbeat plus generation counters to detect a dead or frozen reader, forced
  reclaim once declared dead, and a validity check on every decode so a resurrected reader
  fails closed into the async path rather than reading freed memory.
- Wakeups. A version bump plus a cheap notification so windows know to rerender, kept off
  the read path.
- Main process API. Node reads via async IPC and writes via intents, with types that make
  the asynchrony obvious.
- Persistence. A hook on commit and a rehydrate path on boot, with atomic temp file and
  rename discipline.

**Exit.** A chaos test, windows opened, reloaded, and killed at random for an hour, leaves
no leaked memory, no stuck epoch, and no incorrect read.

## P4 Bindings and developer experience, 3 to 4 weeks

Make the thing pleasant, and answer the objection that decides adoption.

- React. A `useSyncExternalStore` binding. This is the headline feature.
- Vue and Svelte adapters, both thin over the same subscribe and snapshot pair.
- TypeScript. Inferred types from an optional schema declaration, plus types that
  distinguish a synchronous read from an asynchronous write at the call site.
- Debuggability. Custom inspection and `toJSON` on every proxy, a snapshot panel, and a
  retained log of recent roots for time travel. This is a required deliverable, not a
  stretch goal. An opaque store will be rejected regardless of its speed.

**Exit.** A non trivial example application, multi window, with a table of a few thousand
rows, built by someone who did not write the library, using only the published docs.

## P5 Hardening, 4 to 6 weeks

Everything that separates a working prototype from something other people can depend on.

- The trust model as a first class design constraint. See [trust-model.md](trust-model.md).
- Fuzz the decoder against deliberately corrupted arenas. Every decode path fails closed.
- Growth, fragmentation, and exhaustion. Defined behaviour when the arena fills, compaction
  if the soak data says it is needed.
- CI matrix. macOS, Windows, and Linux, x64 and arm64, across the supported Electron majors.
  This library is unusually exposed to Electron internals, so the matrix is not optional.
- Extended soak on every supported platform before any release tag.

**Exit.** Green matrix, a clean fuzz run, and a written security note that a reviewer
outside the project agrees is honest about the tradeoff.

## P6 Release, 2 to 3 weeks

Publish in a way that sets expectations correctly, so the issue tracker is about bugs rather
than misunderstandings.

- Package split: a runtime agnostic core, an Electron integration, and framework bindings.
- Docs that lead with the contract and the trust model, then the benchmark table with a
  reproducible harness, then the API.
- Migration notes from the message passing libraries, including an honest section on when
  not to switch.
- A stability statement naming the supported Electron range and what happens when a new
  major lands.

## Risk register

| Risk | Impact | Mitigation | Caught by |
| --- | --- | --- | --- |
| Shared buffer cannot cross processes with the sandbox on | Fatal | No workaround that preserves the sandbox. Fall back to the fixed layout off ramp, or stop. | P0 |
| Performance win too small to justify the complexity | Fatal | Measure before building anything. The benchmark is written first and kept. | P0 |
| Allocator or reclamation bug corrupts state under rare interleavings | High | Immutability removes most of the surface. Multi process soak is a release gate, not a task. | P1, ongoing |
| A crashed or frozen reader pins memory indefinitely | High | Heartbeat liveness, capped retention, forced reclaim, fail closed decode. | P3 |
| Shared write access weakens the renderer sandbox | High | Cannot be engineered away. Documented trust domain, per window opt out, verified read mode. | P5 |
| Rejected because the state is opaque in DevTools | Medium | Inspection tooling is a P4 deliverable with its own exit criterion. | P4 |
| An Electron major breaks the bootstrap handshake | Medium | Narrow declared support range, CI on each major, a canary job on beta. | P5, ongoing |

## Off ramps

Decided now, while nothing is invested. Each is a coherent product on its own rather than a
failed version of this one.

| If | Ship instead |
| --- | --- |
| P0 fails on sharing | The asynchronous library you would have written anyway: patch based replication with a better API and real TypeScript types. A crowded field, but the existing options have gaps worth filling. |
| The object layer proves too costly | The fixed layout subset: numbers, booleans, and bounded strings, no allocator, no reclamation. Covers counters, flags, progress, selection, and cursor state, and is perhaps a fifth of the work. |
| The trust model blocks adoption | Reposition as a single trust domain tool. Target applications that render only their own bundled UI, and say so in the first paragraph. |

## Schedule note

Solo and part time, the full plan is realistically six to nine months. Phase 0 is three
weeks and answers whether the other eight months are worth starting.
