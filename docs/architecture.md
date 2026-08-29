# Architecture

Two facts dictated the original topology, and a third, measured the hard way, replaced it.
This page describes the shape that ships; the full record of the shape the platform refused
is in [adr/0002-window-open-handshake.md](adr/0002-window-open-handshake.md) and
[../spikes/RESULTS.md](../spikes/RESULTS.md), and the decision that replaced it is
[adr/0003-native-transport.md](adr/0003-native-transport.md).

## Fact one: the V8 memory cage

Since Electron 21, every ArrayBuffer backing store must live inside V8's pointer compression
cage. Memory that arrives from anywhere else, an mmap, a native allocation, another process,
cannot be wrapped in an ArrayBuffer without a copy. This closed the obvious design, a native
addon handing out views over shared memory, and spike 03 documents it.

The native transport does not fight the cage; it routes around it. No JavaScript ArrayBuffer
ever wraps the shared mapping. The addon reads and writes the mapping only inside native
calls, and every byte JavaScript decodes lives in a buffer V8 allocated. The cage is
satisfied by construction rather than by exception.

## Fact two: the web platform does not share memory across renderer processes

The original design assumed a `SharedArrayBuffer` could reach every window over some
platform channel. Phase 0 measured every channel and the answer is no, finally: the HTML
agent cluster rule keeps shared memory inside one cluster, clusters never span the process
boundary the design needed, and the one mechanism that carries the buffer puts every window
in one process. No header, privilege, flag, or Electron version changes it.

## The topology that ships

```
main process                         renderer processes
+------------------------------+     +--------------------------------+
| the owner                    |     | trusted window (sandbox off)   |
|   core OwnerStore over a     |     |   preload: ReaderRegion,       |
|   private buffer             |     |   version check per read,      |
|   OwnerRegion.flush() per    |     |   copy on change, core decode  |
|   commit                     |     |   page: whatever the preload   |
|          |                   |     |   exposes over contextBridge   |
|          v                   |     +--------------------------------+
|   the region file, mapped    |<----  read only mapping, OS enforced
|   read-write here only       |     +--------------------------------+
|                              |     | sandboxed window (async tier)  |
|   ipc: hello, dispatch,      |<--->|   preload-async.cjs: read by   |
|   commit ping, async read    |     |   request, dispatch, ping      |
+------------------------------+     +--------------------------------+
```

- **The owner is the main process.** It runs the ordinary core `OwnerStore` over a private
  buffer, exactly as the worker-thread topology uses it, and publishes each commit into the
  mapped region under the region's slot protocol. There is no hidden window, no privileged
  scheme, no isolation headers, and no handshake: the one thing a window needs from the main
  process is the region's path.
- **A trusted window maps the region read only** from its preload and never blocks on
  anyone: one native version check per read, one seqlock-consistent copy per commit
  observed, and the untouched core decoder over its own private buffer. A read can never
  return a stale version and never a torn one.
- **A sandboxed window maps nothing.** It reads by asking over IPC and hears the same commit
  ping. The two tiers share the write path: every write is an intent the owner applies or
  refuses.

## Where the old design's hard problems went

| Problem the old topology carried | What happened to it |
| --- | --- |
| Bootstrap handshake before first render | Deleted. The preload maps the file itself. |
| COOP and COEP on every response | Deleted. Nothing needs cross origin isolation. |
| Cross process epoch reclamation | Unnecessary. A reader's snapshot pins its own private buffer, and garbage collection is the whole story. |
| Liveness monitoring and forced reclaim | Unnecessary here. A crashed reader leaks nothing shared. The core keeps both for the worker-thread arrangement, where shared decoding still applies. |
| A hostile window corrupting shared state | Unreachable. Everyone but the owner maps the region read only, enforced by the OS. |
| Exposure to Electron serializer internals | Gone. The surface is Node-API, which is ABI stable, and OS file mappings. |

What replaced them is one trade, stated first everywhere it matters: a window that reads
synchronously runs with `sandbox: false`. See [trust-model.md](trust-model.md).

## The region protocol

The region is double buffered: the owner builds every commit in the slot the previous commit
did not publish, brings that slot up to date by copying the previous commit's ranges from
the published slot, and publishes version and slot index as one atomic word. Each slot
carries its own sequence, odd exactly while the writer is inside it, so a reader that copies
a slot can prove the copy brackets no write. A reader retries only when the writer lapped
into its slot mid copy, which the writer cannot sustain, because it must complete an entire
further commit before touching the same slot again. The transport soak drove every part of
this design; the history is in the `@globals/shm` package and its tests.

## Requirements to mechanisms

| Requirement | Mechanism |
| --- | --- |
| Synchronous reads in a window | Preload-side private copy, refreshed on version change, decoded by the core |
| A read never stale | One native version check on every read |
| A read never torn | Per slot sequences bracket the copy; double buffering bounds the retry |
| Writes serialized | One owner, in the main process, applying intents in order |
| Windows learn of commits | A content free IPC ping, never on the read path |
| Sandboxed windows still function | The asynchronous tier over the same intent path |
| Crash of any window survivable | Real process isolation, and nothing shared to corrupt or pin |
| Survives Electron majors | Node-API ABI stability; the matrix and the beta canary verify rather than assume |

## Package split

| Package | Role |
| --- | --- |
| `@globals/core` | Runtime agnostic: arena, encoding, persistent structures, reclamation for topologies that share decoding |
| `@globals/shm` | The transport: the region file, the slot protocol, the addon, prebuilt per platform |
| `@globals/electron` | The integration: the owner in the main process, the preload reader, the async tier, persistence |
| `@globals/react`, `vue`, `svelte` | Bindings over the same subscribe and snapshot pair |
