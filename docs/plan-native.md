# Development plan, second pass: to a working library on the native transport

The successor to [plan.md](plan.md), written after the gate. Phase 0 through 5 built and
hardened everything except a transport the platform turned out not to offer; spike 08
measured one it does. This plan carries the project from that measurement to a shippable
0.2.0 and names what 1.0 still requires. Estimates are focused engineering weeks. Every
phase ends at a written condition, in the tradition the first plan set.

The decision this plan implements is [ADR 0003](adr/0003-native-transport.md): owner in the
main process, one mmap'd region, readers that sync by seqlock-consistent copy on version
change and decode locally with the existing core. The trade, named everywhere: windows that
map the arena run with `sandbox: false`.

## N0 Land the measurements, days

- Commit the spike 07 rerun, spike 08, and the documentation updates to `dev`.
- Accept or amend ADR 0003.
- Close Dependabot #7 (blocked by the workspace peer range, and moot for the SAB question),
  merge #5.
- Make continuous integration honest: the spike 01 matrix job becomes a verdict change
  detector that passes while the measured verdict matches the recorded FAIL and alarms when
  a Chromium changes the answer. The chaos job is disabled until N2 redefines it.

**Exit.** `dev` is green, and the repository states what is true.

## N1 The transport package, 2 to 3 weeks

`@globals/shm` (working name), the productionised descendant of the spike addon. Runtime
agnostic like the core: testable in plain Node with **child processes**, which is a real
process boundary, so no Electron is needed to prove the hard part.

- Region lifecycle: create, open, close, unlink; a header carrying `LAYOUT_VERSION` and the
  arena geometry, refused on mismatch exactly as the core already refuses foreign layouts.
- Owner side `flush(offset, length)`: copy the dirty range in and bump the version inside
  the seqlock. The bump allocator makes dirty ranges cheap to track: a commit is the bytes
  between the old and new bump pointer, plus the root and header.
- Reader side `sync(dest)`: a seqlock-consistent copy with the retry loop in native code,
  returning the version it captured. Plus `version()` at 14 ns for the fast path.
- Control slots for wakeup counters and diagnostics. No reader registry: this topology does
  not need cross process epochs, which is a deletion the first plan could not have.
- Windows support written and tested, not sketched. macOS, Windows, Linux, x64 and arm64.
- Prebuilds (prebuildify or equivalent) so applications install without a toolchain, with
  compile-from-source as the fallback.
- The torture and soak harnesses from the spike, promoted: writer at full rate against
  readers in separate OS processes.

**Exit.** A one hour full rate soak across real child processes with zero torn reads and
zero missed versions, green on all three platforms in CI, and the prebuild loading on every
matrix cell.

## N2 Rewire the Electron package, 2 to 3 weeks

Mostly deletion, which ADR 0003 explains. What remains:

- `startOwner()` runs in the main process: the existing core `OwnerStore` over a private
  ArrayBuffer, flushing on commit. The hidden owner window, the privileged scheme, the COOP
  and COEP responses, and the `window.open` handshake are removed.
- The renderer preload opens the mapping and serves reads: version check, sync on change
  into a local buffer, decode with the untouched core reader. Superseded local buffers are
  garbage collected when the last snapshot drops them; no cross process pinning exists to
  manage.
- Wakeups: a content free IPC ping per commit drives subscriptions; the read path never
  waits on it, and a version poll backstops throttled windows.
- The bridge tax is a design input, measured at 0.5 to 1.1 µs per `contextBridge` crossing:
  the decode layer lives on the preload side, and the main world API crosses the bridge per
  operation, not per property access. Document the honest numbers for both worlds.
- The per window tier split is kept: `sandbox: true` windows get the asynchronous tier only.
- Persistence unchanged, minus the owner window lifecycle it no longer needs.

**Exit.** The e2e application passes its fourteen checks against windows in separate OS
processes, asserted by pid — the check spike 05 taught this project to never skip.

## N3 Chaos, soak, and the matrix, 1 to 2 weeks

- The chaos harness gets its meaning back: windows opened, reloaded, frozen, and killed at
  random for an hour while the owner runs in the main process. The single process failure
  mode that broke it is gone; what it must now prove is no leak, no stuck subscription, and
  no wrong read across reader churn.
- The electron-matrix workflow runs spike 08 per Electron major per platform as the new go
  or no go, keeps spike 01 as the verdict change detector, and runs the chaos job on every
  supported major.
- Benchmarks re-measured through the real stack and `benchmarks.md` rewritten around three
  honest rows: preload side decoded read, main world bridged read, IPC round trip.
- Nightly one hour cross process soak; a recorded twenty four hour soak before any release
  tag, as the first plan required.

**Exit.** Green matrix including chaos, the benchmark table reproduced by the harness in the
repository, and a twenty four hour soak recorded.

## N4 The claim, the docs, and 0.2.0, 1 to 2 weeks

- `trust-model.md` leads with the new sentence: windows that map the arena run without the
  Chromium sandbox, what that removes, who must not use this, and the asynchronous tier as
  the opt out. The rest of the document follows from it.
- `architecture.md` and `stability.md` rewritten for the new exposure surface: Node-API ABI
  stability and mmap semantics, instead of serializer internals and isolation headers. The
  agent cluster finding stays, as the reason this architecture exists.
- `migration.md` gains the sandbox requirement as the first entry in "when not to switch".
- README rewritten around the narrowed claim. CHANGELOG 0.2.0. The npm scope claimed and the
  prebuild publish pipeline exercised end to end.

**Exit.** 0.2.0 tagged from a release branch, installable from the registry on a machine
with no C toolchain, with documentation a stranger could adopt from.

## What 1.0 still requires, unchanged in spirit from the first plan

- [ ] Spike 08 green on every supported Electron major, on all three platforms
- [ ] The chaos harness green on all three platforms
- [ ] A twenty four hour, eight reader soak, recorded
- [ ] The trust note reviewed by someone outside the project who agrees it is honest —
      heavier now than when the plan first asked for it, because the sentence got heavier
- [ ] A non trivial application built by someone who did not write the library, from the
      published docs alone
- [ ] The benchmark table reproduced on hardware that is not the author's

## Risk register

| Risk | Impact | Mitigation | Caught by |
| --- | --- | --- | --- |
| The sandbox trade is unacceptable to the intended audience | Fatal to this claim | External review of the trust note before 1.0; the single process repositioning (spike 05) is the measured fallback that keeps the sandbox | N4, review |
| Electron removes or restricts `sandbox: false` | Fatal | Canary job on the beta; this is the one platform dependency left, so it is watched, not assumed | N3, ongoing |
| Spike 08 fails on Windows or Linux | High | N1 tests child processes on all platforms before any Electron work builds on it | N1 |
| Prebuild or install friction | Medium | Prebuilds for all six platform-arch pairs, compile fallback, install tested in CI | N1, N4 |
| Bridge tax dominates real applications | Medium | Preload side decode, per operation bridging, both worlds benchmarked and documented | N2, N3 |
| The `MAP_FIXED` remap tempts the foundation | Medium | It stays behind a flag with its survival conditions documented, revisited after 1.0 | discipline |

## Schedule note

Six to nine focused weeks from here to 0.2.0, solo and part time meaning roughly a quarter.
The expensive unknowns are behind: the transport is measured, the core is done, and N2 is
mostly deletion.
