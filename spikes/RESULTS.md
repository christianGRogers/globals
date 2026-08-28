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

**A SharedArrayBuffer does not cross a renderer process boundary in Electron 33 by any
mechanism measured here.** The gate fails.

The result took two rounds to get right, and the first round was wrong in the optimistic
direction, so both are recorded.

| Mechanism | Buffer arrives | Windows in separate OS processes | Useful |
| --- | --- | --- | --- |
| `MessageChannelMain` port, main brokered | No, `messageerror` | **Yes**, three distinct pids | No |
| `window.open` plus `postMessage` | **Yes**, both directions | **No**, one pid for every window | No |
| `BroadcastChannel` | No, silently dropped | Yes | No |
| `SharedWorker` | No, dropped in both directions | Yes, pages in two processes | No |

The two rows that matter are the first two, and they are exclusive. The mechanism that keeps
windows in separate processes will not carry the buffer. The mechanism that carries the buffer
puts every window in one process, and it does so for a reason that cannot be configured away:
an opener and the window it opened are same origin related browsing contexts, so they must
share a process in order to script each other synchronously. That is the same property that
makes the direct `postMessage` work.

Measured process ids, from the recorded runs:

```
spike 01, MessageChannelMain:  owner 63620, ui-a 24920, ui-b 61500   buffer: messageerror
end to end, window.open:       owner 28480, shared-a 28480, shared-b 28480, plugin 28480
```

Sharing memory between contexts inside one renderer process is not the problem this library
exists to solve. The premise was one region of real shared memory read synchronously **across
Electron processes**, and that is what is not available.

### The first answer, and why it was wrong

An earlier version of this document said the gate was cleared, on the strength of spike 05
showing a buffer transferring between two sandboxed, cross origin isolated windows in both
directions. Every one of those observations was true. The spike simply did not check whether
the two windows were in different processes, and they were not.

The check that caught it was added only because the chaos harness crashed a renderer and took
the owner down with it, which does not happen unless they share a process. Without that
accident the wrong conclusion would have survived, which is an argument for measuring the
thing you are actually claiming rather than a proxy for it.

Both spikes now report process ids, and the process separation check is part of the gate.

### What this means for the project

The off ramps in [docs/plan.md](../docs/plan.md) were written for exactly this outcome and
the decision between them is a product decision rather than a technical one:

1. **Ship the asynchronous library.** Patch based replication with a better API and real
   types. Phases 1 and 2 are not wasted: the arena, the object layer, and the persistent
   structures are runtime agnostic and none of them depend on the handshake.
2. **Reposition as single process.** The `window.open` topology genuinely works and gives
   synchronous shared reads to every window, at the cost of putting them all in one renderer
   process. A crash in any window takes the rest with it, and process isolation between
   windows is gone. That is a real product for applications that render only their own UI and
   would accept the trade, but it is a much narrower claim than the one the plan opens with.
3. **Stop.** The gate is the gate.
4. **Step outside the web platform.** Spike 08 measured the route the web APIs cannot
   offer: a file-backed region mapped into every process by an N-API addon and read through
   native accessor calls, which keeps the V8 memory cage out of the picture. It delivers the
   original contract, synchronous cross-process reads with zero torn reads under a full rate
   writer and accessor reads at 14 ns against a 35 µs IPC round trip, at the price the
   original gate refused to pay: `sandbox: false` on every window that maps the arena.
   That is not a pass of the gate. It is a different product with the same API and a heavier
   trust sentence, and it is measured rather than hypothesised.

## Status of each spike

| Spike | Status | Verdict |
| --- | --- | --- |
| 01 share a buffer, MessageChannelMain | Run | FAIL, and the failure is the useful part |
| 02 atomics torture | Run | PASS |
| 03 memory cage | Not run | Blocked on a C toolchain, conclusion documented from the V8 design |
| 04 read latency | Run, Node arm only | PASS with a large margin |
| 05 window.open | Run | PASS, this is the mechanism the library must use |
| 06 BroadcastChannel | Run | FAIL |
| 07 SharedWorker | Rerun, instrumented | FAIL in both directions, and the reason closes the question |
| 08 native mmap, sandbox off | Run, macOS arm64 | PASS, 14 ns accessor reads, zero torn reads, ~2500x IPC |

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

## Spike 07, the closing result

The first run recorded "never connected over a custom protocol and surfaced no error", and
that conclusion was wrong. Rerun with the worker instrumented (macOS arm64, Electron 33.4.11
and 44.0.0, 2026-08-28), the worker connects on every transport, including the custom
scheme. It had been dying at top level on `new SharedArrayBuffer`, because a shared worker's
global scope is not cross origin isolated even when its script is served with
`Cross-Origin-Embedder-Policy: require-corp`, and a runtime error inside a SharedWorker
surfaces nothing in the pages that created it. The original result was silence mistaken for
absence.

With the worker unable to throw and reporting its own state, every variant fails on the
transfer itself:

| Variant | Electron | Worker connects | SAB in worker scope | Buffer crosses |
| --- | --- | --- | --- | --- |
| custom scheme, COOP and COEP | 33 | yes | absent, constructor throws | no, page's seed dropped |
| localhost HTTP, COOP and COEP | 33 | yes, pages in two processes | absent | no, page's seed dropped |
| HTTP plus the `SharedArrayBuffer` feature flag | 33 | yes | present | no, `messageerror` in both pages |
| HTTP plus flag, no isolation headers anywhere | 33 | yes | present | no, `messageerror` in both pages |
| localhost HTTP, COOP and COEP | 44, Chromium 152 | yes | absent | no, page's seed dropped |
| HTTP plus flag | 44 | yes | present | no, `messageerror` in both pages |

Both directions are dropped: worker to page and page to worker. Headers do not change it,
the flag that exposes the constructor does not change it, and nineteen Chromium majors do
not change it.

The reason is in the HTML specification rather than in Electron. A `SharedArrayBuffer`
deserialises only within one agent cluster, and a shared worker agent is allocated an agent
cluster of its own, never the one the windows share. The same rule accounts for every
mechanism this phase measured: same origin windows related by `window.open` share a cluster,
so the buffer crosses there (spike 05), and Chromium keeps a cluster in one process, which
is why those windows colocate; independent windows are separate clusters, which is why the
port and the broadcast drop the buffer. The premise, shared memory read synchronously
across renderer processes, is not a missing Electron feature or a Chromium bug. The
platform defines shared memory as intra cluster, and maps cluster boundaries onto exactly
the process boundaries the premise needed to cross.

The rerun also hardened the spike against the mistake spike 05 made: it reports each page's
OS process id and requires them to differ, and it requires each page to observe the other's
write through its own mapping of the buffer rather than through a relayed message.

## Spike 08, the route outside the platform

macOS arm64, Electron 33.4.11, 2026-08-28. A 1 MB file-backed region mapped by an N-API
addon into the main process and two renderer processes, all pids confirmed distinct. The
renderers run `sandbox: false` with context isolation on; the addon lives in the preload and
the page reaches it only through `contextBridge`.

```
owner value seen through the mapping:      both pages
peer write seen directly through memory:   both directions
torture, writer publishing at full rate:   770k+ consistent reads, 0 violations

raw accessor read (one N-API call)         13-16 ns
seqlock record read, 64 doubles validated  256-289 ns
1 MB copy into an in-cage buffer           15-17 us
read crossing contextBridge                0.5-1.1 us
real ipcRenderer.invoke round trip         35-40 us

gate: PASS, threshold is 50 times, measured ~2500
```

Reading of this result:

- The premise is physically available outside the web APIs. The kernel maps the region into
  every process and the atomics hold, exactly as spike 02 predicted for the protocol.
- The V8 memory cage is routed around, not fought: no ArrayBuffer ever wraps the shared
  region. Accessor calls cost 13 to 16 ns, and the real decoded read the library already
  benchmarks at 418 ns would not notice the transport underneath it.
- The copy on version change hybrid is nearly free: a 14 ns version check per read and a
  16 µs memcpy per commit buy full speed TypedArray reads from an ordinary in-cage copy,
  with no unsupported behaviour anywhere.
- `contextBridge` is the expensive boundary now, at about a microsecond per crossing. The
  decode layer belongs preload side, or reads cross the bridge batched.
- The `--remap` arm, `MAP_FIXED` over an in-cage ArrayBuffer, also ran clean: the remapped
  TypedArray is live shared memory read at 0.80 ns. An existence proof with documented
  survival conditions, not a foundation.
- What it costs: the Chromium sandbox, off, for every window that maps the arena. The
  original gate refused exactly this trade, so this is off ramp four rather than a pass.
  Unmeasured so far: Windows, Linux, other Electron majors, soak length behaviour.

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
| A buffer reaches a sandboxed renderer in another process | **Failed.** No mechanism measured does both. |
| Reads at least 50 times faster than an IPC round trip | Cleared, measured 79 times against the real decoder |
| Atomics hold across contexts | Cleared for threads, untested across renderer processes because no buffer reaches one |

The plan said to stop the project if a buffer cannot reach a sandboxed renderer without
disabling the sandbox. The sandbox was never the obstacle: the process boundary is. Which off
ramp to take is a product decision, and the three are set out above.

The spike 07 rerun settled how final this is. The transfer is refused by the HTML
specification's agent cluster rule, not by an Electron serializer gap, so no header, flag,
privilege, or future Chromium version changes the answer. The last mechanism is measured,
and the gate failure is a property of the web platform.
