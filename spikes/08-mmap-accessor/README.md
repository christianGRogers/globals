# Spike 08: mmap through a native accessor, sandbox off

Phase 0 closed every web platform route: the HTML agent cluster rule keeps a
`SharedArrayBuffer` inside one cluster, and clusters never span the process boundary the
premise needed to cross. This spike steps outside the web platform. A file-backed region is
mapped into the main process and into two renderer processes by an N-API addon, and read
through native accessor calls, so the V8 memory cage never sees a foreign pointer.

The price is `sandbox: false` on every window that maps the arena. Context isolation stays
on and the page keeps no Node access, since the addon lives in the preload, but the Chromium OS
sandbox for those renderers is gone, and no framing makes that small. It is the trade the
trust model would have to lead with.

## Verdict: PASS, measured

macOS arm64, Electron 33.4.11, 2026-08-28. Three processes confirmed distinct by pid.

| Measurement | Result |
| --- | --- |
| Owner's value visible in both renderers through the mapping | yes |
| Each page sees the other's write directly through its own mapping | yes, both directions |
| Torn reads under a writer publishing at full rate, 2 s, both pages | **0** in 770k+ consistent reads |
| Raw accessor read (`loadSlot`, one N-API call) | **13 to 16 ns** |
| Consistent seqlock record read, 64 doubles validated | **256 to 289 ns** |
| 1 MB refresh copy into an in-cage buffer (`copyInto`) | **15 to 17 µs** |
| Read crossing `contextBridge` (what an app pays with isolation on) | 0.5 to 1.1 µs |
| Real `ipcRenderer.invoke` round trip, same machine | 35 to 40 µs |
| Gate: accessor at least 50× faster than IPC | **cleared, roughly 2400 to 2700×** |

The comparison that matters: the arena's real decoded read costs 418 ns
([../../docs/benchmarks.md](../../docs/benchmarks.md)), so a native accessor at 14 ns is not
the bottleneck: the existing decode path could sit on this transport with its performance
story intact. And the copy-on-version-change hybrid (check `version()`, ~14 ns; `memcpy` 1 MB
only on commit, ~16 µs; serve reads from the in-cage copy at full TypedArray speed) gives
zero-copy-grade reads with no unsupported behaviour at all.

The `contextBridge` number is a design input: reads issued one-by-one from the main world
pay ~1 µs each, so the decode layer belongs on the preload side of the bridge, or reads
should cross it batched.

## The remap arm, `--remap`

The deliberately dangerous variant: `mmap(MAP_FIXED, MAP_SHARED)` of the same file over the
page-aligned interior of an ordinary in-cage `ArrayBuffer`, giving a TypedArray whose pages
are physically shared across processes. Zero copy, no accessor call, no cage violation
visible to V8.

Measured: the remapped view is live (the owner's heartbeat ticks through it), reads cost
**0.80 ns**, indistinguishable from a plain local read, and nothing crashed. The survival
conditions are real and documented in the source: the backing buffer is leaked deliberately,
the mapping only covers the aligned interior, and a V8 upgrade could invalidate the
allocator assumptions. It runs after the base report is sent, so a crash would cost the
experiment, not the measurement. Treat it as an existence proof and a future optimisation,
not the foundation.

## What this does and does not change

It does not pass the original gate. The plan's stop condition was a buffer that reaches a
**sandboxed** renderer, and this reaches an unsandboxed one, the exact thing the gate
refused to trade away. What it adds is a fourth off-ramp with numbers attached: the original
contract, synchronous cross-process reads, the existing core unchanged, in exchange for
naming the windows that map the arena as unsandboxed trusted surface. Node-API is
ABI-stable, so the addon also removes the design's exposure to Electron serializer
internals, the thing that killed the original handshake, at the cost of shipping prebuilt
binaries per platform.

Not yet measured: Windows and Linux (the addon has a Windows mapping path, the remap arm
does not), Electron majors other than 33, and soak-length behaviour.

## Running it

```bash
cd spikes/08-mmap-accessor && npx node-gyp rebuild && cd ../..
node spikes/run-spike.mjs 08              # the supported accessor route
node spikes/run-spike.mjs 08 -- --remap   # plus the MAP_FIXED experiment
```
