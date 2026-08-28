# ADR 0002: The window.open handshake, and why it does not rescue the design

- Status: rejected as a solution, kept as the record of what was measured
- Date: 2026-08-28
- Relates to: [ADR 0001](0001-hidden-owner-window.md)

## Context

ADR 0001 assumed a handshake: the main process creates a `MessageChannelMain`, hands one port
to the owner and one to each window, and the buffer travels renderer to renderer over that
port.

Spike 01 measured it. With both ends cross origin isolated, `SharedArrayBuffer` available in
both, and the sender's `postMessage` not throwing, the receiver gets `messageerror` and the
payload is dropped. Plain and growable buffers fail identically. The three windows were in
three different OS processes, so this is a genuine cross process failure.

Spike 05 then measured `window.open` plus `postMessage`, and the buffer arrived, in both
directions, with the sandbox and context isolation intact. That looked like the answer.

It was not. Every window in that topology is in the same OS process. An opener and the window
it opened are same origin related browsing contexts, so Chromium must keep them in one process
for `window.opener` to work at all. The property that makes the direct post succeed is the
same property that removes the process boundary.

Measured, from the recorded runs:

```
MessageChannelMain:  owner 63620, ui-a 24920, ui-b 61500   buffer: messageerror
window.open:         owner 28480, and every window 28480   buffer: arrives
```

## Decision

`window.open` is not adopted as the handshake, because it does not deliver what the project
is for. Sharing memory between contexts inside one renderer process is not the problem; the
premise was shared memory across Electron processes.

No handshake is adopted. The gate has failed and the choice is between the off ramps in
[plan.md](../plan.md), which is a product decision rather than an engineering one.

## Consequences

- The Electron integration in this repository implements the `window.open` handshake, because
  that is how the finding was arrived at and it is the only thing that runs end to end. It
  should be understood as a demonstration of the single process topology, not as a shipping
  design for the original claim.
- The core is unaffected. It is runtime agnostic, it never depended on the handshake, and it
  survives into any of the off ramps.
- If a future Electron makes `MessageChannelMain` carry a `SharedArrayBuffer`, the original
  design becomes viable again with no change to the core. Spike 01 is the test to rerun, and
  it now checks process separation, so it cannot pass for the wrong reason.

## What would have caught this sooner

The gate condition was written as "a buffer reaches a sandboxed renderer". It should have been
"a buffer reaches a sandboxed renderer **in a different OS process**", which is what the plan
meant everywhere else and what the value proposition depends on. A gate that does not name the
property it is protecting can be passed by something that does not have it.
