# Benchmarks

Every performance claim in this repository comes from a harness that ships with it:
`benchmarks/read-latency.ts` for the arena in isolation, and the native benchmark app for
the whole stack inside real Electron. Run them yourself:

```bash
npm run bench          # the arena, in Node
npm run bench:native   # the real path: preload, decode, bridge, and IPC, in Electron
```

## Machine

| Field | Value |
| --- | --- |
| CPU | 13th Gen Intel Core i7-13700H, 20 logical cores |
| Memory | 32 GB |
| Operating system | Windows 11, build 10.0.26200, x64 |
| Node | 22.13.1 |
| Date | 2026-08-28 |
| Arguments | `--iterations 800 --batch 2000 --roundTrips 1500` |

## Results

Nanoseconds per operation, with verified read mode on, which is the default.

| Measurement | Mean | p50 | p99 |
| --- | --- | --- | --- |
| Shared read, double | 418.2 | 399.4 | 682.0 |
| Shared read, int32 | 349.5 | 329.6 | 499.8 |
| Shared read, string | 1758.9 | 1659.5 | 2646.4 |
| Snapshot acquire, no decode | 159.9 | 152.2 | 253.5 |
| Plain local property read | 3.2 | 2.9 | 14.3 |
| Structured clone round trip | 32976.5 | 30000.0 | 84600.0 |

A shared read of a double is **79 times faster** than a round trip and costs about **132
times** a plain local property read.

**Verification is free on this benchmark, and that is the point of how it is built.** The
checksum is computed once per commit and checked once per version, so a loop reading the same
version pays nothing. Turning it off moves the numbers by less than the run to run noise.

## The real stack, measured in Electron

The arena numbers above isolate the decoder. An application does not call the decoder; it
calls `select()` in a preload, or crosses the contextBridge from a page, and its alternative
is a real `ipcRenderer.invoke` round trip. The native benchmark measures those, in a real
renderer process over the native transport, on a different machine from the table above, so
compare ratios within each table rather than numbers across them.

| Field | Value |
| --- | --- |
| CPU | Apple M4, 10 logical cores |
| Memory | 32 GB |
| Operating system | macOS 26.4.1, arm64 |
| Electron | 33.4.11 |
| Date | 2026-08-28 |
| State | 2000 rows, 1 MB region |

Nanoseconds per operation.

| Measurement | Mean | p50 | p99 |
| --- | --- | --- | --- |
| Plain local property read | 4.7 | 4.2 | 9.7 |
| `select`, double, preload side | 252.7 | 248.2 | 515.4 |
| `select`, string, preload side | 563.0 | 533.9 | 1615.4 |
| Snapshot acquire, no decode | 51.2 | 51.1 | 63.0 |
| `select`, double, across the contextBridge | 873.3 | 850.0 | 950.0 |
| `select` observing a fresh commit | 79491.5 | 75417.0 | 149875.0 |
| `ipcRenderer.invoke` round trip | 34815.7 | 34084.0 | 48416.0 |

Reading these numbers honestly:

- A synchronous decoded read in the preload is **138 times faster** than the real IPC round
  trip it replaces, and the round trip here is the genuine article rather than the worker
  thread stand-in the arena benchmark uses.
- A page with context isolation on pays the bridge: 873 ns per crossing, still **40 times
  faster** than IPC and synchronous. This is why the decode layer belongs on the preload
  side and why a page API should return everything a render needs in one crossing.
- Observing a fresh commit costs about 80 µs: the version check misses, the region is
  copied, and a fresh reader attaches. That price is paid once per commit per window, not
  per read, and it is roughly two IPC round trips for a whole consistent state. Every read
  until the next commit is back at 253 ns.
- The plain local read row says what it always says: shared state is not free. Fifty times
  a local property read is the cost of the guarantee that the value is the committed one.

## Reading these numbers honestly

**The round trip arm is conservative.** It uses a Node worker thread, not an Electron process
boundary. Real `ipcRenderer.invoke` is slower, so the ratio understates the advantage rather
than overstating it.

**The phase 0 spike was optimistic by two orders of magnitude.** Spike 04 modelled the read
path as one atomic load and a three level walk, and measured 7.8 ns. The real path measures
418 ns. The model left out everything that makes the read safe:

| Cost | Why it is there |
| --- | --- |
| Two validity checks per read | The version must be proven live on both sides of the decode, or a forced reclaim can hand back a well formed wrong value |
| Bounds checking every offset | Any window mapping the arena can write a slot, so a wild offset is a reachable state |
| Block header validation | Turns a wild offset into a typed error rather than a plausible value |
| Seqlock read of the root | Five atomic loads and a comparison, so the tag, payload, version, and checksum come from one commit |

None of that is optional, and the plan predicted the wrong number rather than the wrong
design. The gate asked for 50 times and the real path delivers 79, so the conclusion stands
with less headroom than the spike suggested.

**The string arm is the slow one.** 1.8 microseconds for a moderate length string is
dominated by materialising a JavaScript string from UTF-16 code units, which is inherent
rather than a decoder problem. Applications that read the same string every frame should hold
the snapshot rather than reread it, which is what the framework bindings do.

## What was tuned, and what was not

Three changes moved the number from 659 ns to roughly 420 ns:

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
