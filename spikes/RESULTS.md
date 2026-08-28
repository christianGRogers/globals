# Phase 0 results

Recorded runs, with the machine described, so the numbers can be reproduced or disputed.

## Machine

| Field | Value |
| --- | --- |
| CPU | 13th Gen Intel Core i7-13700H, 20 logical cores |
| Memory | 32 GB |
| Operating system | Windows 11, build 10.0.26200, x64 |
| Node | 22.13.1 |
| Date | 2026-08-27 |

## Status of each spike

| Spike | Status | Verdict |
| --- | --- | --- |
| 01 share a buffer | Not yet run | Blocked on a local Electron install and a display |
| 02 atomics torture | Run | PASS |
| 03 memory cage | Not yet run | Blocked on a C toolchain, conclusion documented from the V8 design |
| 04 read latency | Run, Node arm only | PASS with a large margin |

Spikes 01 and 03 need a runtime that this machine does not currently have configured.
Neither is guessed at below. Their rows say not yet run, and the project gate is not
considered cleared until spike 01 has been run on each supported Electron major.

## Spike 02, atomics torture

```
node spikes/run-spike.mjs 02 -- --workers 4 --seconds 3 --increments 50000

PASS  contended counter
        expected: 200000
        actual: 200000
        lostUpdates: 0
PASS  message passing ordering
        generations: 14789909
        reads: 45686798
        violations: 0
PASS  seqlock under a writer at full rate
        versions: 18859689
        reads: 118306616
        retries: 67332718
        retryRate: 0.362707
        violations: 0

gate: PASS, atomics behave as the protocol assumes
```

Reading of this result:

- Zero lost updates over 200,000 contended compare and exchange operations.
- Zero ordering violations over 45.7 million reads while a writer republished a 64 word
  payload as fast as it could. A violation here would mean a reader saw a new sequence
  number next to a stale payload word, which is exactly the failure the protocol cannot
  tolerate.
- Zero torn records over 118 million seqlock reads. The 36 percent retry rate is expected
  and is an artifact of the writer running with no pause at all. In the real design the
  seqlock guards only the root and epoch handshake, which the writer touches once per
  commit rather than continuously.

The caveat that matters: this runs across worker threads inside one process. It validates
the protocol, not the platform. Spike 01 validates the platform.

## Spike 04, read latency

```
node spikes/run-spike.mjs 04 -- --iterations 2000 --batch 2000 --roundTrips 3000

  measurement                     mean       p50       p99
  shared memory read                 7.8       6.8      22.8
  plain local object read            3.8       3.2       9.2
  structured clone round trip    33503.5   30500.0   84400.0

  shared read is 4306 times faster than a round trip
  shared read costs 2.0 times a plain local property read

gate: PASS, threshold is 50 times, measured 4306
```

Reading of this result:

- A modelled shared read, one atomic load plus a three level walk of tagged slots, costs
  roughly twice a plain local property access. That is the number that decides whether a
  render path can call it freely, and twice a property read is cheap enough.
- The round trip arm is a Node worker thread, not an Electron process boundary. Real
  `ipcRenderer.invoke` is slower, so 4306 times is a conservative floor rather than a
  headline. The gate threshold is 50 times, so there is roughly two orders of magnitude of
  headroom before the complexity stops paying for itself.
- The number to distrust is the shared read arm, because it models the walk rather than
  performing it against a real arena. Phase 1 replaces this model with the real decoder
  and the benchmark moves to `benchmarks/`.

## Gate verdict so far

| Gate condition | Verdict |
| --- | --- |
| A buffer reaches a sandboxed renderer | Unproven, spike 01 outstanding |
| Reads at least 50 times faster than an IPC round trip | Cleared, measured 4306 times |
| Atomics hold across contexts | Cleared for threads, unproven across renderer processes |

Phase 1 proceeds at risk. That is a deliberate choice rather than an oversight: the arena
is runtime agnostic and, if spike 01 fails, most of Phase 1 survives into the asynchronous
off ramp described in [docs/plan.md](../docs/plan.md). The parts that would be wasted are
the epoch reclamation protocol and the seqlock handshake, which is roughly two of the six
weeks.
