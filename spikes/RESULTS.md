# Phase 0 results

Recorded runs, with the machine described, so the numbers can be reproduced or disputed.

## Machine

| Field | Value |
| --- | --- |
| CPU | 13th Gen Intel Core i7-13700H, 20 logical cores |
| Memory | 32 GB |
| Operating system | Windows 11, build 10.0.26200, x64 |
| Node | 22.13.1 |
| Electron | 33.4.11, Chromium 130.0.6723.191 |
| Date | 2026-08-28 |

## The gate, answered

**A SharedArrayBuffer can be shared between two sandboxed, context isolated, cross origin
isolated renderers. The project is viable.**

What does not work is the handshake the design assumed. The buffer will not survive a
MessageChannelMain port, which is Electron's serializer rather than Chromium's. It survives a
post to a window opened with `window.open`, which is Chromium's own path.

| Mechanism | Result | Spike |
| --- | --- | --- |
| `MessageChannelMain` port, main brokered | **Fails.** The receiver gets `messageerror` and the payload is dropped | 01 |
| `window.open` plus `postMessage` | **Works**, in both directions | 05 |
| `BroadcastChannel` | Fails. Silently dropped, not even a `messageerror` | 06 |
| `SharedWorker` owning the buffer | Never connected over a custom protocol, and surfaced no error | 07 |

The consequence for the design is in [ADR 0002](../docs/adr/0002-window-open-handshake.md).
The topology is unchanged: a hidden owner renderer still owns the arena and the Node main
process still stays off the read path. What changes is that the owner must open the windows
that need the shared tier, because only an opener and its opened window can post a buffer to
each other.

## Status of each spike

| Spike | Status | Verdict |
| --- | --- | --- |
| 01 share a buffer, MessageChannelMain | Run | FAIL, and the failure is the useful part |
| 02 atomics torture | Run | PASS |
| 03 memory cage | Not run | Blocked on a C toolchain, conclusion documented from the V8 design |
| 04 read latency | Run, Node arm only | PASS with a large margin |
| 05 window.open | Run | PASS, this is the mechanism the library must use |
| 06 BroadcastChannel | Run | FAIL |
| 07 SharedWorker | Run | Inconclusive, treated as unavailable |

## Spike 01, the negative result

```
crossOriginIsolated=true in every window, SharedArrayBuffer=function
owner: posted a plain SharedArrayBuffer
owner: posted the growable buffer to peer 1
ui-a:  MESSAGEERROR: a message could not be deserialised here
ui-b:  MESSAGEERROR: a message could not be deserialised here
```

Both ends are cross origin isolated and `SharedArrayBuffer` exists in both. The owner's
`postMessage` does not throw. The receiver gets `messageerror`, which is what a failed
deserialisation looks like from the receiving side, and the payload is dropped.

Both a plain and a growable buffer fail identically, so this is not about growable buffers
being newer. It is the port.

This is the gap the architecture document already suspected when it said `MessagePortMain`
has known gaps around transferables. The suspicion was right and the design leaned on the
mechanism anyway, which is exactly what a phase 0 spike is for.

## Spike 05, the mechanism that works

```
opener crossOriginIsolated=true
child  crossOriginIsolated=true
opener: posted the buffer to the opened window
child:  RECEIVED 1024 bytes, owner value seen: true

PASS  window.open was allowed
PASS  posting the buffer did not throw
PASS  the opened window received the buffer
PASS  the opened window read the opener's value
PASS  the opener saw the opened window's write
```

Both directions verified: the opened window reads a value the opener wrote before the
transfer, and the opener sees a value the opened window wrote afterwards. Both windows have
`sandbox: true` and `contextIsolation: true`, which is what makes the result usable rather
than academic.

## Two bugs that hid the answer for a long time

Worth writing down, because both produced silence rather than an error and both sent the
investigation somewhere wrong.

**Top level `await app.whenReady()` deadlocks in an ES module main entry.** The ready event
does not fire until the entry module has finished evaluating, so awaiting it at module scope
waits for something that is waiting for you. The process hangs with no output on every
platform. This was originally diagnosed as "Electron cannot reach ready in this session, so
there must be no interactive desktop", which was wrong, and the wrong diagnosis stood for a
long time because it was plausible.

**A MessagePort cannot be passed through `contextBridge`.** The bridge serialises what
crosses it, so the page receives an object carrying the port's own properties and none of its
prototype. Calling `start()` or `addEventListener()` on it throws. The way to get a working
port into the main world is `window.postMessage` from the preload with the port in the
transfer list.

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

## Gate verdict

| Gate condition | Verdict |
| --- | --- |
| A buffer reaches a sandboxed renderer | **Cleared**, through window.open. Not through MessageChannelMain. |
| Reads at least 50 times faster than an IPC round trip | Cleared, measured 79 times against the real decoder |
| Atomics hold across contexts | Cleared for threads. Cross renderer atomics follow from the buffer being genuinely shared, which spike 05 demonstrates in both directions. |

Phase 1 was written at risk against an unproven gate. The risk paid off: the core is runtime
agnostic and none of it depended on the handshake. What has to change is the Electron
integration, which is one package.
