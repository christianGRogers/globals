# Inspecting state

The loudest objection to a store like this is that state is opaque in DevTools, and it
decides adoption regardless of how fast the reads are. So inspection is a required
deliverable rather than a stretch goal.

## Values print as values

Every view implements `toJSON`, so `JSON.stringify`, the DevTools object inspector, and a
`console.log` all show the data rather than a proxy:

```ts
console.log(store.get());          // the object, expandable
JSON.stringify(store.get());       // the data
snapshot.toJSON();                 // a detached plain value, no proxies
```

`toJSON` decodes the whole structure, which is exactly what the lazy path exists to avoid.
That is fine in a console and wrong in a render loop.

## What is in the arena

```ts
import { formatArena, reportArena } from "@globals/core";

console.log(formatArena(owner));
```

```
globals arena, layout 1, owner generation 1

  version           4821
  reclaim floor     4820
  commits           4821
  forced advances   0

  capacity          4.00 MB
  used              612.5 KB
  live              498.2 KB (81.3%)
  free lists        114.3 KB
  stranded          0 B
  interned strings  5013

  retained versions 2, 4820 to 4821
  readers
    slot 0 generation 1, pinned at 4821, 0 behind
    slot 1 generation 3, pinned at 4817, 4 behind
```

`reportArena` returns the same picture as data, for a panel or a metric.

| Field | What a bad value means |
| --- | --- |
| `forced advances` | A window is not keeping up and is losing its snapshots. Nonzero in production is worth a look. |
| `stranded` | Blocks larger than the biggest size class are being freed and dropped. Climbing over time means compaction is needed. |
| `live` against `used` | Low utilisation means fragmentation. |
| `interned strings` | Climbing without bound means a workload writing unbounded distinct strings, which belongs in the asynchronous tier. |
| A reader many versions behind | That window is about to be force advanced. |

## What a window can see about itself

```ts
import { reportReader } from "@globals/core";

reportReader(connection.reader);
// { slot, generation, pinnedEpoch, publishedVersion, reclaimFloor,
//   lagVersions, headroomVersions }
```

`headroomVersions` is the number that matters: how many more commits can happen before this
reader is force advanced and its snapshot fails closed. A window that keeps seeing a small
number here is not keeping up.

## Time travel

The retained version ring already holds the last N roots, because reclamation needs it to.
Reading them costs nothing extra, but keeping them alive does, so it is off by default:

```ts
ArenaOwner.create({ historyDepth: 16 });
```

With `historyDepth: 0`, the default, a version is reclaimed as soon as no reader is pinned to
it and there is no history to browse. A positive value keeps that many superseded versions
readable, at the cost of holding their path copies. Turn it on in development.

```ts
import { VersionHistory, diffShallow } from "@globals/core";

const history = new VersionHistory(reader);
history.list();               // every retained version, oldest first
history.read(versionId);      // materialise one, pinning only for the call
const pinned = history.pin(versionId);  // hold one, and release it
diffShallow(history.read(n - 1), history.read(n));
```

Two warnings that are not decoration:

**This is not an undo stack.** Retention is bounded, so history extends back exactly as far
as the ring and no further, and a version drops off the end without notice. An application
that needs durable undo should record its own operations.

**A reader owns one epoch slot.** Pinning a past version suspends the pin the render path was
holding until the historical snapshot is released. A debug panel should attach its own
reader:

```ts
const inspector = ArenaReader.attach(connection.buffer, { heartbeat: false });
```

`heartbeat: false` keeps the panel from looking alive to the liveness detector when the
window behind it is not.

## When a read fails

| Error | What happened | What to do |
| --- | --- | --- |
| `StaleSnapshotError` | The version you held was reclaimed | Reacquire. Expected under load. |
| `ArenaCorruptError` | A decode found something a correct writer cannot produce | Treat as a security event as well as a bug. Some window wrote to the arena. |
| `ArenaFullError` | The arena is exhausted and cannot grow | Raise `maxByteLength`, or move large values to the asynchronous tier. |
| `NoReaderSlotError` | Every reader slot is claimed | Raise `maxReaders`, or find the reader that never detached. |

An `ArenaCorruptError` in the field is the one to escalate. Every decode path validates
before it dereferences, so this error means the check did its job, and it also means
something wrote bytes a correct writer would not have written.
