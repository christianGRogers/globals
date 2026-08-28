# Contributing

## Before you start

Read [docs/contract.md](docs/contract.md). The synchronous read and asynchronous write
split constrains every API in this repository, and a change that blurs it will be rejected
regardless of how convenient it is.

## Setup

```bash
npm install
npm run build
npm test
```

Node 20.11 or newer is required. The core package has no runtime dependencies and no
Electron dependency, which is deliberate: it must stay testable in plain Node with worker
threads.

## Branching

See [docs/branching.md](docs/branching.md). Branch from `dev`, merge into `dev`, and never
delete a branch after merge.

## What a change needs

| Change | Also needs |
| --- | --- |
| A new encoding or arena layout change | A layout version bump and a round trip property test |
| A change to the reclamation protocol | A soak run result posted in the pull request |
| A new public API | Types, a documentation entry, and an example |
| A performance claim | A benchmark run from `benchmarks/`, with the machine described |

## Invariants that reviews enforce

1. The writer never mutates a published node. New versions are built with structural
   sharing and installed with one atomic store.
2. Every decode path validates its offset and fails closed. A corrupt arena must raise a
   typed error, never dereference a bad offset.
3. Nothing on the read path performs IPC, allocates a promise, or awaits.
4. A reader never blocks a writer and a writer never blocks a reader.

## Documentation style

Technical writing without filler. State the constraint, then the mechanism, then the
failure mode. Do not use em dashes. Prefer a table over a paragraph when the content is
a mapping.

## Tests

```bash
npm test          # unit and property tests
npm run soak      # multi process soak, minutes by default
npm run bench     # read latency harness
```

The soak harness gates releases. A change to the arena that has not been through a soak
run is not ready to merge.
