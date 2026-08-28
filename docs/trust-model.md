# Trust model

Read this before adopting the library. It describes a real weakening of the renderer
sandbox that cannot be engineered away.

## The property

A `SharedArrayBuffer` is writable by every process that holds it. There is no read only
mapping and no per window permission on the bytes. Any window that maps the arena can write
anywhere in the arena, including the header, the root pointer, the epoch table, and the
allocator metadata.

That partially undoes what `sandbox: true` buys you. The sandbox contains a compromised
renderer inside its own process. It does not contain writes to memory that renderer legally
holds.

## Consequences, stated plainly

| A window mapping the arena can | Effect |
| --- | --- |
| Write a garbage root pointer | Every reader sees a corrupt tree until the owner recommits |
| Write a garbage value slot | Other windows read a wrong but well formed value |
| Write a bad offset into a node | Decoders must fail closed, which is why every decode validates |
| Clear its own epoch slot while reading | It observes a `StaleSnapshotError`, other windows are unaffected |
| Hold an epoch slot forever | Retention grows to the cap, then the owner force advances |
| Overwrite the allocator free region | The owner detects the header checksum mismatch and rebuilds |

None of these escape the renderer process. All of them corrupt shared application state.

## The three responses

### 1. One trust domain, documented

Every window that maps the arena is inside one trust domain. If you would not let a window
call your privileged main process handlers directly, do not give it the arena.

### 2. Per window opt out

A window created with `sharedTier: false` never receives the buffer. It gets the
asynchronous replicated tier: reads are `await`ed, writes go through the same intent path,
and the synchronous API is absent from its bundle rather than throwing at runtime.

```ts
createWindowStore(win, { sharedTier: false });
```

Use it for any window that renders content you do not control: a web view of a third party
page, a plugin surface, a documentation browser.

### 3. Verified read mode

The owner publishes a checksum over the header and the current root with each commit. In
verified mode a reader recomputes it before exposing a snapshot. This detects corruption by
a buggy or hostile window that does not also forge the checksum. It does not stop a window
that computes a valid checksum for corrupt data, because that window has the same
information the owner does.

Verified mode costs one pass over the header and root record per version, not per read.

| Mode | Detects | Does not detect | Cost |
| --- | --- | --- | --- |
| `off` | Nothing | Everything | Zero |
| `header` | Header and root corruption | Forged checksum, corrupt leaf values | One hash per version |
| `full` | Any change to a retained version | Forged checksum | One hash per version over the reachable set |

## What the design does mitigate

- **Freed memory reads.** Epoch reclamation plus a validity check on every decode. A reader
  pinned to a reclaimed version raises `StaleSnapshotError` rather than reading recycled
  bytes.
- **Bad offsets.** Every decode path bounds checks against the arena length and against the
  record header of the node it is walking. A failure raises `ArenaCorruptError`.
- **Unbounded pinning.** Liveness heartbeats plus a retention cap. A dead or frozen reader
  is declared dead and its epoch slot is reclaimed.

## What it does not mitigate

- A window inside the trust domain deliberately writing wrong values.
- A window inside the trust domain reading state it should not see. Everything in the arena
  is visible to everything that maps the arena. Do not put per window secrets in it.

## Guidance

1. Put no credentials, tokens, or per user secrets in the shared tier.
2. Give untrusted windows `sharedTier: false`.
3. Turn on `header` verification in production. Turn on `full` when diagnosing corruption.
4. Treat an `ArenaCorruptError` in the field as a security event, not only a bug.
