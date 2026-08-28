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

## Running the gate

Spike 01 is the go or no go for the whole project. Everything else is written against the
claim that it passes.

```bash
npm install
npm run gate
```

Electron is a saved development dependency, so `npm install` is all the setup there is. Three
windows open, two of them visible. Leave them alone for about a second and they close on
their own. The verdict prints in the terminal and is written to
`spikes/01-share-buffer/spike01-result.json`.

### Reading the result

```
PASS  crossOriginIsolated in every window
PASS  sandbox and contextIsolation stayed on
PASS  every reader received the buffer
PASS  readers observed the owner write
PASS  owner observed a reader write
PASS  grow() was observed by readers

gate: PASS, the topology is implementable on this Electron version
```

The checks are ordered so that the first failure tells you what kind of problem you have.

| First failing check | What it means | What to do |
| --- | --- | --- |
| `crossOriginIsolated` | The protocol headers are not reaching the document | A spike bug, not a platform verdict. Nothing below it is meaningful. |
| `sandbox and contextIsolation` | The window is not configured the way the gate requires | Same. The result is worthless without both on. |
| `every reader received the buffer` | **The gate itself failed.** A `SharedArrayBuffer` will not cross to a sandboxed renderer on this Electron version | Take an off ramp in `docs/plan.md`. This is the answer the spike exists to get. |
| `readers observed the owner write` | The transfer copied rather than shared | Same as above. The topology does not work. |
| `owner observed a reader write` | Sharing is one directional | Surprising, and it would change the trust model rather than end the project. |
| `grow() was observed` | Growth is not seen by processes already holding the buffer | Not fatal. Arena size becomes fixed at bootstrap and a rehandshake path is needed. |

A run that produces no report at all is a broken run rather than a gate failure, and the
runner says so rather than reporting a verdict it does not have.

### The other Electron gate

The window lifecycle chaos harness, which is the half of the phase 3 exit criterion that
needs real renderer processes:

```bash
npm run gate:chaos
```

Four windows are opened, reloaded, and crashed at random for a minute while the owner commits
continuously. It asserts that no window reported an inconsistent read and that the owner
survived. Its runtime agnostic counterpart, `npm run chaos`, already passes and covers the
reclamation logic without a window manager.

### Seeing it work

```bash
npm run gate:example
```

The four window example: a table of five thousand rows read synchronously on the render path,
an editor that demonstrates the read after write contract, a debug panel, and a window on the
asynchronous tier. See [examples/multi-window/README.md](../examples/multi-window/README.md).

## What the Node only spikes can and cannot prove

Node worker threads share a `SharedArrayBuffer` inside one process. That is enough to
validate the protocol itself: the atomic handshake, memory ordering assumptions, the
reclamation state machine, and relative read cost. It is not enough to validate the platform
claim, which is that Chromium shares the backing store across separate renderer processes.
Only spike 01 answers that, and only under Electron.

Both matter. A protocol that is wrong will fail in Node. A protocol that is right can still
be unimplementable if spike 01 fails.
