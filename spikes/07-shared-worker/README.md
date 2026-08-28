# Spike 07: let a SharedWorker own the buffer

A SharedWorker is one instance shared by every same origin context, which is exactly the
single writer the design needs, and its ports are created by Chromium rather than by
Electron's serializer. If a buffer survived this route, the topology would be implementable
with a different handshake, and no window relationship at all.

## Verdict: FAIL, and this time it is the platform, stated in the spec

The first run of this spike recorded "never connected over a custom protocol", which was
wrong. The worker always connected. It died at top level on `new SharedArrayBuffer`,
because a shared worker's global scope is not cross origin isolated, and a runtime error
inside a SharedWorker surfaces nothing in the pages that created it. Silence, not evidence.

Instrumented so the worker cannot throw at top level and reports its own state, the
measurements are:

| Variant | Electron | Worker connects | Worker isolated | SAB in worker | Buffer crosses |
| --- | --- | --- | --- | --- | --- |
| custom scheme, COOP/COEP | 33 | yes | no | absent | no, seed dropped |
| localhost HTTP, COOP/COEP | 33 | yes, pages in 2 processes | no | absent | no, seed dropped |
| HTTP + `SharedArrayBuffer` feature flag | 33 | yes | no | present | no, `messageerror` in both pages |
| HTTP + flag, no isolation headers anywhere | 33 | yes | no | present | no, `messageerror` in both pages |
| localhost HTTP, COOP/COEP | 44 (Chromium 152) | yes | no | absent | no, seed dropped |
| HTTP + flag | 44 | yes | no | present | no, `messageerror` in both pages |

Both directions fail: a buffer created in the worker is dropped on its way to every page,
and a buffer created in a page is dropped on its way to the worker. Headers do not change
it, the feature flag that exposes the constructor does not change it, and nineteen Chromium
majors do not change it.

The reason is the HTML specification, not an Electron gap. A `SharedArrayBuffer`
deserialises only within one agent cluster, and a shared worker agent is allocated its own
agent cluster, never the one the windows share. The same rule explains every other result
in phase 0: same origin windows related by `window.open` share one cluster, so the buffer
crosses (spike 05), and Chromium keeps one cluster in one process, which is why those
windows colocate. Cross process shared memory between windows is not a missing feature.
The platform defines shared memory as intra cluster, and defines clusters to never span
what Chromium maps to separate processes.

## Running it

```bash
node spikes/run-spike.mjs 07                                    # custom scheme, the original
node spikes/run-spike.mjs 07 -- --transport=http                # localhost HTTP with COOP/COEP
node spikes/run-spike.mjs 07 -- --transport=scheme-full         # every scheme privilege
node spikes/run-spike.mjs 07 -- --transport=http --sab-flag     # expose SAB by feature flag
node spikes/run-spike.mjs 07 -- --transport=http --sab-flag --no-isolation
```

The spike reports the OS process id of each page and requires them to differ, and requires
each page to observe the other's write through its own mapping of the buffer rather than
through a relayed message. Both checks exist because spike 05 once passed for the wrong
reason.
