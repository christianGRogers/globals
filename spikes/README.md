# Phase 0 spikes

Throwaway code that answers whether the library can exist. Nothing here ships, and nothing
here is held to the quality bar of `packages/`. The value is the recorded measurement in
[RESULTS.md](RESULTS.md).

## The gate

Stop the project if any of these fail.

1. A `SharedArrayBuffer` cannot reach a sandboxed renderer without disabling the sandbox.
2. Reads are less than roughly 50 times faster than an IPC round trip, in which case the
   complexity buys nothing.
3. Atomics do not hold across renderer processes, in which case there is no safe protocol
   to build.

## The spikes

| Spike | Question | Runtime needed |
| --- | --- | --- |
| [01-share-buffer](01-share-buffer) | Does one buffer reach two sandboxed renderers? | Electron |
| [02-atomics-torture](02-atomics-torture) | Do atomics hold under adversarial interleaving? | Node, and Electron for the cross renderer variant |
| [03-memory-cage](03-memory-cage) | Does the native addon route share or copy? | Node with a C toolchain |
| [04-read-latency](04-read-latency) | How much faster is a shared read than IPC? | Node, and Electron for the IPC arm |

## Running them

```bash
node spikes/run-spike.mjs list
node spikes/run-spike.mjs 02        # runs in plain Node
node spikes/run-spike.mjs 04        # runs in plain Node
node spikes/run-spike.mjs 01        # requires a local Electron install
```

The Electron spikes are not part of continuous integration. They need a display and a
specific Electron version, and they are diagnostic rather than regression tests. Install
Electron locally to run them:

```bash
npm install --no-save electron@^33
node spikes/run-spike.mjs 01
```

## What the Node only spikes can and cannot prove

Node worker threads share a `SharedArrayBuffer` inside one process. That is enough to
validate the protocol itself: the atomic handshake, memory ordering assumptions, the
reclamation state machine, and relative read cost. It is not enough to validate the platform
claim, which is that Chromium shares the backing store across separate renderer processes.
Only spike 01 answers that, and only under Electron.

Both matter. A protocol that is wrong will fail in Node. A protocol that is right can still
be unimplementable if spike 01 fails.
