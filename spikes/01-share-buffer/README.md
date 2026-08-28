# Spike 01: share a buffer across sandboxed renderers

## Question

Can one `SharedArrayBuffer`, allocated in a hidden window, be read and written by two
visible windows, with `sandbox: true` and `contextIsolation: true` intact?

This is the go or no go for the whole project.

## Setup

- A privileged custom scheme, `globals-spike://`, served by `protocol.handle`. Every
  response carries `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which is what makes `crossOriginIsolated`
  true and `SharedArrayBuffer` transferable.
- One hidden owner window and two visible reader windows, all with the sandbox on.
- The main process creates a `MessageChannelMain` pair per reader and hands one port to
  each side. The buffer travels renderer to renderer over those ports. It never passes
  through Node, which is the point of the topology.

## Checks

| Check | Meaning if it fails |
| --- | --- |
| `crossOriginIsolated` in every window | The protocol headers are not being applied, fix before drawing conclusions |
| Sandbox and context isolation stayed on | The result is worthless, the gate requires them on |
| Every reader received the buffer | The topology does not work, take the off ramp |
| Readers observed the owner write | The transfer copied instead of sharing |
| Owner observed a reader write | Sharing is one directional, which would change the trust model |
| `grow()` observed by readers | If it fails, arena size is fixed at bootstrap and a rehandshake path is needed |

The renderer asserts the sandbox condition through `process.sandboxed` and
`process.contextIsolated` rather than trusting what the configuration file says.

## Running

```bash
npm install --no-save electron@^33
node spikes/run-spike.mjs 01
```

The process exits 0 when every check passes and 1 otherwise, so it can be wired into a
manual gate review.

## Note on the growth check

`SharedArrayBuffer.prototype.grow` returns a longer view to every holder without a new
transfer, because the backing store is reserved up to `maxByteLength` at allocation. If
that turns out not to hold on a given Electron version, the fallback is to allocate the
maximum arena at bootstrap and accept the reserved address space, which costs address
space rather than resident memory on all three supported platforms.
