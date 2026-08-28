# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffold, workspace layout, and branching model.
- Continuous integration: build matrix, soak, Electron matrix, CodeQL, gated release.
- Phase 0 feasibility spikes, with recorded results in `spikes/RESULTS.md`.
- `@globals/core`: the shared memory arena, tagged value encoding for the scalar type
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
- `@globals/electron`: the hidden owner window, a privileged custom scheme that sets COOP
  and COEP on every response, the port handshake, named write operations, the per window
  shared or asynchronous tier split, and an asynchronous main process API.
- `LivenessMonitor` in the core, which reaps the reader slot a crashed or frozen window
  left claimed and pinned.
- Persistence with debounced writes and temp file plus rename discipline.
- A chaos harness that opens, reloads, freezes, and kills simulated windows while a writer
  runs, plus its Electron counterpart for the electron-matrix workflow.
- `@globals/react`, `@globals/vue`, and `@globals/svelte`, all over the same subscribe
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
