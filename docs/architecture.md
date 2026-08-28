# Architecture

Two platform facts, both discoverable before writing a line of the library, dictate the
topology. Neither is negotiable, and together they rule out the design most people would
sketch first.

## Fact one: the V8 memory cage

Since Electron 21, V8 refuses to treat memory outside its own cage as an `ArrayBuffer`
backing store. The obvious native addon approach, which is to `mmap` a POSIX shared region,
wrap it with `napi_create_external_arraybuffer`, and hand it to JavaScript, no longer
shares. It copies. That closes the addon route for the shared region itself, in the
renderer and in Node alike.

Spike `spikes/03-memory-cage` records the copy so the route is never revisited.

## Fact two: the Node main process is not a good sharing peer

Passing a `SharedArrayBuffer` from the Electron main process into a renderer is long
requested and not dependably supported, and `MessagePortMain` has known gaps around
transferables. Chromium by contrast already shares `SharedArrayBuffer` backing stores
between cross origin isolated renderer processes. That path is load bearing production code
inside the browser.

## The topology those facts force

The state owner is **not** the Node main process. It is a hidden `BrowserWindow`, a
renderer like any other, which can therefore share memory with the visible windows on the
supported path. The Node main process participates over ordinary asynchronous IPC, entirely
off the read path.

```text
  Main process             Owner window              UI window A     UI window B
  Node, outside the cage   hidden renderer           reader          reader
  files, menus, quit       sole writer               sends intents   sends intents
        |                  allocates the arena             |               |
        |   async IPC      publishes roots                 |               |
        +----------------->       |                       |               |
                                  |                       |               |
                          +-------+-----------------------+---------------+
                          |
      One SharedArrayBuffer, the same physical bytes in every renderer
      header, epoch table, retained ring, string table, arena
```

This inverts the usual Electron advice, and it is the single claim Phase 0 exists to prove
or kill.

## Requirements to mechanisms

Each of the four requirements maps to one mechanism and one specific way it can fail.

### 1. Same memory

A growable `SharedArrayBuffer` allocated by the owner window and handed to each renderer at
bootstrap. It requires `crossOriginIsolated`, which means serving the application through a
custom protocol that sets COOP and COEP.

Principal risk: the transfer may not survive the hop with the sandbox on. This is the go or
no go decision, and Phase 0 exists to make it.

### 2. Real data

Tagged eight byte slots over a byte arena. Small integers are inline, everything else is a
32 bit offset. Key and string tables are interned. Persistent structures, a HAMT for objects
and maps and a chunked vector for arrays, keep a one field write to a handful of copied
nodes rather than the whole graph.

Principal risk: the allocator plus reclamation is the largest single body of work and the
easiest to get subtly wrong.

### 3. Consistency

Immutability plus an atomic root swap. The writer never mutates a published node. It builds
a new version with structural sharing and atomically stores the new root. A reader that has
loaded a root is traversing a graph that cannot change under it, so torn reads are
impossible by construction rather than merely detected.

Principal risk: this is only correct if the writer truly never mutates in place. That needs
enforcement, not discipline.

### 4. Non blocking

Epoch based reclamation. A reader publishes its epoch with one atomic store, loads the root,
reads freely, and publishes exit. The owner reclaims a version once every reader has moved
past it. No reader ever waits. The seqlock retry survives only as a guard on the root and
epoch handshake, with a bounded spin and a last good snapshot fallback.

Principal risk: a reader that dies or freezes mid traversal pins memory forever. That needs
liveness detection and fail closed decoding.

### How 3 simplifies 4

Because published data is immutable, the retry loop collapses to a single atomic load in the
common case. The seqlock earns its keep only where the root pointer and the epoch table are
updated together.

## Package split

The split exists so the core stays testable without Electron and reusable beyond it.

| Package | Depends on | Contents |
| --- | --- | --- |
| `@globals/core` | Nothing | Arena, encoding, persistent structures, reclamation, snapshots |
| `@globals/electron` | `@globals/core` and Electron | Owner window, protocol, handshake, lifecycle, persistence |
| `@globals/react` | `@globals/core` | The `useSyncExternalStore` binding |
| `@globals/vue` | `@globals/core` | Reactive adapter |
| `@globals/svelte` | `@globals/core` | Store adapter |
