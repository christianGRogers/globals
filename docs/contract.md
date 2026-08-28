# The contract

Everything in this repository depends on stating the contract precisely, and on the
documentation leading with it rather than burying it.

## Guarantee

**Reads are synchronous.** `store.get()` returns the current committed value on the line
you call it, in any window, with no `await` and no round trip.

**Writes are asynchronous.** A window sends an intent, the owner applies it, and every
window observes the result shortly after. The line following your write may still read the
old value.

## Why the split is not negotiable

A write must be serialized against every other write, and serialization has to happen
somewhere. One process has to decide the order. Readers can be given the illusion of
immediacy because immutable published data can be handed out without coordination.
Writers cannot, because ordering is the whole job.

Any API that appears to offer a synchronous write across processes is either lying,
blocking, or single window.

## What follows from it

```ts
store.set((draft) => { draft.count += 1; });
store.get().count;            // may still be the old value

await store.set((draft) => { draft.count += 1; });
store.get().count;            // now reflects the write
```

Code that needs read after write consistency awaits the write. Code that renders needs only
the synchronous read, which is the case this library exists to serve.

## Consistency model

| Property | Guarantee |
| --- | --- |
| Read of a single value | Always a committed value, never a partial one |
| Read of several values in one snapshot | All from the same version, no tearing |
| Two snapshots taken at different times | May be different versions |
| Write ordering | Total order, decided by the owner |
| Write visibility | Eventual, bounded by one owner turn plus one notification |
| Read of a reclaimed version | Typed `StaleSnapshotError`, never freed memory |

A snapshot is a version. Once you hold one, the graph beneath it cannot change, because the
writer never mutates a published node. That is what makes torn reads impossible by
construction rather than merely detectable.

## Snapshot lifetime

A reader pins the version it currently exposes. The writer cannot reclaim a version while
any reader is pinned to it. Retention is capped, so a reader that stops advancing does not
grow the arena without bound. Past the cap the writer force advances, and a stale snapshot
raises `StaleSnapshotError` on its next decode, which is the fail closed path.

## What the contract does not promise

- It does not promise that a write is visible to the writing window before the next line.
- It does not promise that two windows observe two writes at the same instant, only in the
  same order.
- It does not promise that every JavaScript value is encodable. Values outside the type
  ladder go to the asynchronous tier through a visibly different API, so the boundary is
  legible in the calling code instead of a runtime surprise.
