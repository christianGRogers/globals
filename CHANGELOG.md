# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-29

The native transport ([ADR 0003](docs/adr/0003-native-transport.md)). The web platform
route failed its gate finally, for the reason recorded in
[spikes/RESULTS.md](spikes/RESULTS.md), and this release replaces it end to end.

### Added

- `@bradensbay/globals-shm`: the native transport. One file backed region mapped by a Node-API addon,
  an owning writer double buffering between two data slots, per slot sequences and
  versions, and reader copies that are always exactly one commit. Readers map the region
  read only, enforced by the operating system. Typed failures, a layout version the
  attach refuses to misread, prebuilds for six platform and architecture pairs, and a
  cross process soak that runs an hour nightly.
- `@bradensbay/globals`, rebuilt over the transport: `startNativeOwner` in the main process
  with optional rehydrating persistence, `connectNative` for trusted preloads, the shipped
  `preload-async.cjs` and `asyncPreloadPath()` for windows that keep their sandbox, and
  commit notifications off the read path.
- The native end to end gate, nineteen checks against real windows in separate OS
  processes asserted by pid; the window lifecycle chaos harness the old topology could not
  survive, owner uninterrupted through reloads, renderer kills, and recreations; and the
  native read latency benchmark, measuring what an application pays on each side of the
  contextBridge.
- Spikes 07 and 08, closing the web platform question and measuring the native answer.
- The three window example application, two tiers on screen.

### Changed

- The trust model leads with the real trade: windows that read synchronously run with
  `sandbox: false`. Shared state integrity got stronger, not weaker: only the owner can
  write the region.
- The `electron-matrix` workflow runs the native gates per Electron major and platform and
  keeps spike 01 as a verdict change detector for the closed web route.
- Reads that observe a fresh commit can never return a stale or torn state: one version
  check per read, one region copy per commit observed.

### Removed

- The window.open machinery: the hidden owner window, the privileged scheme and its
  isolation headers, the bootstrap handshake, the renderer port vocabulary, and the old
  preload. Cross process epoch pinning and the liveness monitor are unnecessary in the new
  topology; the core keeps them for the worker thread arrangement where shared decoding
  still applies.

## [0.1.0] - 2026-08-28

First pre-release. The contract, the arena, the object layer, the Electron integration, the
framework bindings, and the hardening work. The feasibility gate that decides whether the
topology works on a given Electron version has not been cleared on a machine with a display,
which [docs/stability.md](docs/stability.md) states rather than implies.

### Added

- Documentation: the contract, the trust model, migration notes that open with when not to
  switch, an API reference, and a stability statement naming the supported Electron range.
- Repository scaffold, workspace layout, and branching model.
- Continuous integration: build matrix, soak, Electron matrix, CodeQL, gated release.
- Phase 0 feasibility spikes, with recorded results in `spikes/RESULTS.md`.
- `@bradensbay/globals-core`: the shared memory arena, tagged value encoding for the scalar type
  ladder, a size class allocator over a bump region, interned strings, and epoch based
  reclamation with bounded retention.
- The multi process soak harness, which gates every change to the arena.
- The kept read latency benchmark, and `docs/benchmarks.md`.
- The object layer: a HAMT for objects, maps, and sets, a chunked persistent vector for
  arrays, and the extended type ladder through `Date`, `RegExp`, `BigInt`, and typed
  arrays.
- A draft based write API, `owner.update`, that rebuilds only the paths a recipe touched.
- A lazy read view that decodes on property access and revalidates the version each time,
  plus `snapshot.get(path)` and `snapshot.toJSON()`.
- `OwnerStore` and `ReaderStore`, which separate reading from writing in the type system.
- `ExternalTier`, the asynchronous escape hatch for values the ladder cannot encode.
- `@bradensbay/globals`: the hidden owner window, a privileged custom scheme that sets COOP
  and COEP on every response, the port handshake, named write operations, the per window
  shared or asynchronous tier split, and an asynchronous main process API.
- `LivenessMonitor` in the core, which reaps the reader slot a crashed or frozen window
  left claimed and pinned.
- Persistence with debounced writes and temp file plus rename discipline.
- A chaos harness that opens, reloads, freezes, and kills simulated windows while a writer
  runs, plus its Electron counterpart for the electron-matrix workflow.
- `@bradensbay/globals-react`, `@bradensbay/globals-vue`, and `@bradensbay/globals-svelte`, all over the same subscribe
  and snapshot pair, with node comparing selectors for container slices.
- `defineSchema` and the typed store interfaces, which keep a synchronous read and an
  asynchronous write from looking alike at the call site.
- Inspection: `formatArena`, `reportArena`, `reportReader`, and `diffShallow`.
- `VersionHistory`, time travel over the retained ring, opt in through `historyDepth`.
- A four window example application over five thousand shared rows.
- Verified read mode, off, header, or full, with the checksum published inside the seqlock.
- A decoder fuzzer that corrupts a realistic arena at random and requires every failure to be
  a typed error from this library.
- Exhaustion and fragmentation tests, and a scavenge path that serves a request from a larger
  size class rather than refusing a write when memory is available.

### Security

- A rejected write no longer consumes the arena permanently. It used to leave behind the
  strings it had interned, and interned strings are never freed during normal operation, so a
  window that could request writes could exhaust the arena with writes that were all refused.
  A rollback now forgets those strings and rewinds the bump pointer to where the commit
  started.

### Fixed

- Forced reclamation freed memory before raising the reclaim floor, which let a reader
  return a well formed but wrong value at a rate of about two reads in four million. The
  floor now rises first and snapshots revalidate after decoding.
- The reclaim floor could be lowered by a reclaim pass immediately after an eviction had
  raised it, which undid the eviction from a reader point of view.
- Building a vector from a list of slots pushed elements one at a time, copying the tail leaf
  on every push. Building a twenty thousand element array churned megabytes of intermediate
  blocks and could exhaust an arena with ample room for the result. It is now built bottom up
  in one pass.
- HAMT and vector allocations were not journalled, so a commit that failed part way leaked
  every node it had built.
- `decodeBigInt` built its value by shifting one byte at a time, which is quadratic in time
  and allocation. A corrupt length of a quarter megabyte churned tens of gigabytes.
- A corrupted vector element count made the decoder build an enormous array. The count is now
  rejected when it exceeds what the buffer could hold.
- A collision node in the trie stored its entry count as a plain integer and nothing
  validated it against the block holding it, so a corrupt count sent every walker off to
  visit billions of entries with no bound inside the loop.
- Trie traversal had a depth bound but no total budget, so a corrupt child pointer forming a
  cycle could still fan out to roughly a trillion visits inside the depth limit.
- Decoding nested containers had no depth limit, so a cycle across separate structures
  recursed until the stack went and produced an untyped error.
- Verified reads compared a checksum from one version against a root from another, because
  the checksum was loaded after the seqlock window rather than inside it. It reported
  corruption that was not there at a rate of roughly fifty in eight hundred thousand reads.

[Unreleased]: https://github.com/christianGRogers/globals/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/christianGRogers/globals/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/christianGRogers/globals/releases/tag/v0.1.0
