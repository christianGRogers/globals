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

### Fixed

- Forced reclamation freed memory before raising the reclaim floor, which let a reader
  return a well formed but wrong value at a rate of about two reads in four million. The
  floor now rises first and snapshots revalidate after decoding.
- The reclaim floor could be lowered by a reclaim pass immediately after an eviction had
  raised it, which undid the eviction from a reader point of view.
