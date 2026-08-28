# ADR 0001: The state owner is a hidden renderer, not the main process

- Status: accepted
- Date: 2026-08-27
- Deciders: repository owner

## Context

The library needs one process to own state and one region of memory that every window can
read synchronously. The obvious owner is the Electron main process, because that is where
Electron applications usually keep authoritative state.

Two platform facts rule that out.

1. Since Electron 21, V8 will not treat memory outside its own cage as an `ArrayBuffer`
   backing store. A native addon that maps a POSIX shared region and wraps it with
   `napi_create_external_arraybuffer` produces a copy, not a shared view.
2. Handing a `SharedArrayBuffer` from the Node main process to a renderer is not
   dependably supported, and `MessagePortMain` has known gaps around transferables.

Chromium already shares `SharedArrayBuffer` backing stores between cross origin isolated
renderer processes. That path is load bearing production code inside the browser rather
than a documented Electron feature that may or may not hold.

## Decision

The state owner is a hidden `BrowserWindow`. It allocates the arena, is the sole writer,
and publishes roots. Visible windows map the same buffer and read synchronously. The Node
main process participates over ordinary asynchronous IPC and never touches the arena.

## Consequences

Positive:

- The read path uses the one sharing mechanism that Chromium supports in production.
- Nothing on the read path depends on the main process, so main process work cannot stall a
  render.
- The core is testable in plain Node with worker threads, because the owner is just another
  peer holding the same buffer.

Negative:

- An extra hidden window costs a renderer process, roughly 30 to 60 MB of resident memory.
- The application must be served over a custom protocol that sets COOP and COEP, because
  `crossOriginIsolated` is required. That constrains how applications load their assets.
- Main process reads are asynchronous, which inverts the usual Electron mental model and
  has to be documented prominently.
- If the owner window crashes, state is rebuilt from the persistence hook rather than held
  in a process that Electron guarantees to keep alive.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| Native addon with `mmap` and an external `ArrayBuffer` | The V8 cage copies rather than shares. Demonstrated in spike 03. |
| `SharedArrayBuffer` allocated in the main process | Not dependably transferable to renderers, and gaps in `MessagePortMain`. |
| Replicate state per window over IPC | This is the existing solution space. It cannot provide a synchronous first read in a new window, which is the whole point. |
| A separate `utilityProcess` as owner | Same cage and transfer problems as the main process, with less tooling. |
