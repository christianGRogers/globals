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

### Fixed

- Forced reclamation freed memory before raising the reclaim floor, which let a reader
  return a well formed but wrong value at a rate of about two reads in four million. The
  floor now rises first and snapshots revalidate after decoding.
- The reclaim floor could be lowered by a reclaim pass immediately after an eviction had
  raised it, which undid the eviction from a reader point of view.
