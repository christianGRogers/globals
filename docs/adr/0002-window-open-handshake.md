# ADR 0002: The owner opens the windows that share its buffer

- Status: accepted
- Date: 2026-08-28
- Supersedes: the handshake described in [ADR 0001](0001-hidden-owner-window.md). The
  topology in ADR 0001 stands.

## Context

ADR 0001 established that the arena owner is a hidden renderer rather than the Node main
process, because Chromium shares `SharedArrayBuffer` backing stores between renderers and the
V8 cage rules out the native addon route.

It also assumed a handshake: the main process creates a `MessageChannelMain`, hands one port
to the owner and one to each window, and the buffer travels renderer to renderer over that
port. That is the documented Electron pattern for connecting two renderers directly.

Spike 01 measured it, and it does not work. With both ends cross origin isolated and
`SharedArrayBuffer` available in both, the owner's `postMessage` does not throw and the
receiver gets `messageerror`. The payload is dropped. A plain buffer and a growable buffer
fail identically, so it is not about growable buffers being newer.

The architecture document already suspected this. It says `MessagePortMain` has known gaps
around transferables, and then the design leaned on the mechanism anyway. Phase 0 exists to
catch exactly that.

Three alternatives were measured:

| Mechanism | Result |
| --- | --- |
| `window.open` plus `postMessage` | Works, both directions, sandbox and context isolation intact |
| `BroadcastChannel` | Silently dropped, not even a `messageerror` |
| `SharedWorker` owning the buffer | Never connected over a custom protocol, no error surfaced |

## Decision

The owner window opens every window that needs the shared tier, using `window.open`. The
buffer is posted directly from the owner to the opened window over the window messaging
channel Chromium provides between an opener and its opened window.

The main process keeps control of what those windows look like through
`setWindowOpenHandler` and `overrideBrowserWindowOptions`, so window size, position, and web
preferences are still the application's decision and still enforced in the main process.

## Consequences

Positive:

- The mechanism is Chromium's own, and it is the same path a browser uses between an opener
  and its opened window. It is not an Electron specific feature with gaps.
- The topology from ADR 0001 is unchanged. The owner is still a hidden renderer, the main
  process is still off the read path, and the core is unaffected.
- Sandboxing and context isolation are unaffected. The opened window inherits the same web
  preferences.

Negative:

- **A window that needs the shared tier must be opened by the owner.** An application that
  creates windows with `new BrowserWindow` in the main process and expects them to join the
  shared tier will not work. This is the largest constraint the library imposes and it has to
  be first in the integration documentation.
- The main process no longer decides when a window exists, only what it looks like. An
  application that wants to open a window asks the owner to do it.
- A window opened with `noopener` cannot join the shared tier, because the relationship is
  the mechanism.
- Any window that is not opened by the owner falls back to the asynchronous tier. That is not
  a new concept, it is the per window opt out from the trust model arriving by a different
  route.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| `MessageChannelMain`, the original design | Measured, does not transfer a buffer. Spike 01. |
| `BroadcastChannel` | Measured, the buffer is silently dropped. Spike 06. |
| A `SharedWorker` as the owner | Measured, never connected over a custom protocol. Attractive if it worked, since it needs no window relationship and would save a renderer process. Worth revisiting if Electron's support changes. Spike 07. |
| Passing the buffer through the main process | The reason ADR 0001 exists. Node cannot usefully hold it. |
