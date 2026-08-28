# Benchmarks

Every performance claim in this repository comes from `benchmarks/read-latency.ts`. Run it
yourself:

```bash
npm run bench
```

## Machine

| Field | Value |
| --- | --- |
| CPU | 13th Gen Intel Core i7-13700H, 20 logical cores |
| Memory | 32 GB |
| Operating system | Windows 11, build 10.0.26200, x64 |
| Node | 22.13.1 |
| Date | 2026-08-27 |
| Arguments | `--iterations 800 --batch 2000 --roundTrips 1500` |

## Results

Nanoseconds per operation.

| Measurement | Mean | p50 | p99 |
| --- | --- | --- | --- |
| Shared read, double | 431.5 | 397.7 | 644.1 |
| Shared read, int32 | 327.5 | 311.3 | 510.4 |
| Shared read, string | 1710.2 | 1630.3 | 2489.3 |
| Snapshot acquire, no decode | 137.3 | 132.7 | 225.3 |
| Plain local property read | 3.6 | 3.4 | 6.3 |
| Structured clone round trip | 36194.7 | 30800.0 | 124900.0 |

A shared read of a double is **84 times faster** than a round trip and costs about **120
times** a plain local property read.

## Reading these numbers honestly

**The round trip arm is conservative.** It uses a Node worker thread, not an Electron
process boundary. Real `ipcRenderer.invoke` is slower, so the ratio understates the
advantage rather than overstating it.

**The phase 0 spike was optimistic by two orders of magnitude.** Spike 04 modelled the read
path as one atomic load and a three level walk, and measured 7.8 ns. The real path measures
431 ns. The model left out everything that makes the read safe:

| Cost | Why it is there |
| --- | --- |
| Two validity checks per read | The version must be proven live on both sides of the decode, or a forced reclaim can hand back a well formed wrong value |
| Bounds checking every offset | Any window mapping the arena can write a slot, so a wild offset is a reachable state |
| Block header validation | Turns a wild offset into a typed error rather than a plausible value |
| Seqlock read of the root | Four atomic loads and a comparison, so the tag, payload, and version come from one commit |

None of that is optional, and the plan predicted the wrong number rather than the wrong
design. The gate asked for 50 times and the real path delivers 84, so the conclusion stands
with less headroom than the spike suggested.

**The string arm is the slow one.** 1.7 microseconds for a moderate length string is
dominated by materialising a JavaScript string from UTF-16 code units, which is inherent
rather than a decoder problem. Applications that read the same string every frame should
hold the snapshot rather than reread it, which is what the framework bindings do.

## What was tuned, and what was not

Three changes moved the number from 659 ns to 431 ns:

1. Header accessors read a cached view directly. The header is at a fixed offset inside
   every view the arena has ever had, so probing the buffer for growth on each access bought
   nothing and cost the most of anything on the path.
2. Views pick up growth at an explicit synchronisation point rather than on every access.
   Reading `byteLength` from a growable `SharedArrayBuffer` is not an inlined field load.
3. The reader holds the header array directly instead of reaching through the arena on each
   of the four validity loads per read.

What was deliberately not traded away:

- The second validity check after the decode. Removing it makes reads roughly 15 percent
  faster and reintroduces a bug the soak measured at two wrong values in four million reads.
- Any bounds check. The trust model rests on them.

## Regenerating this page

```bash
npm run bench
```

Paste the machine block and the table. If a number moves by more than 20 percent, say why in
the pull request. A performance change with no explanation is a regression waiting to be
rediscovered.
