# Epoch reclamation

How memory is freed while readers are running, and why no reader ever waits.

## The problem

The writer publishes a new root and the old version becomes garbage. It cannot be freed
immediately, because a reader may be part way through decoding it. Locking the readers out
would put a blocking operation on the read path, which the contract forbids.

## The mechanism

Each reader owns a slot in a table in shared memory. Reading is:

1. Seqlock read of the root tag, the root payload, and the version id.
2. One atomic store publishing the version this reader is pinned to.
3. One atomic load of the reclaim floor, to confirm the version is still retained.

The writer reclaims a version once no reader is pinned at or below it. There is no
handshake, no message, and nothing for a reader to wait on.

## The ordering argument

This is the part that is easy to get wrong, so the order is written down rather than left
to be rediscovered. It is implemented in `ArenaOwner.reclaim` and `ArenaReader.acquire`.

The writer, on every commit:

1. Scan the reader table for the minimum pinned version.
2. Publish the resulting floor with an atomic store.
3. Scan the table again.
4. Free only versions below the minimum of the two scans.

The reader, on every acquire:

1. Read the root under the seqlock.
2. Publish its pin with an atomic store.
3. Load the floor. Retry if the version it read is below it.

There is no interleaving in which a reader proceeds with a version the writer then frees.
Suppose there were. The reader would have to load a floor value from before the writer
published the new one, which puts the reader load before the writer store in the total
order. The reader pin precedes its own floor load, so the pin also precedes the writer
store, and therefore precedes the writer second scan. That scan sees the pin, so the writer
does not free. Contradiction.

## Validation on both sides of a decode

The argument above covers acquisition. It does not by itself cover the decode, because a
forced reclaim can free memory beneath a reader that is already pinned.

So `Snapshot.value` validates before the decode and again after it, and the owner raises the
floor before it frees anything. A version still above the floor once the decode has finished
cannot have been freed during the decode.

Validating only beforehand leaves a real window. The soak harness found it at a rate of
about two reads in four million, as a well formed but wrong value rather than an error. That
is the worst kind of failure this library can have, which is why the soak is a release gate
rather than a task.

## Bounded retention

The retained version ring has a fixed capacity, 64 by default. When a commit needs the ring
slot that an older live version occupies, that version is reclaimed whether or not a reader
is pinned to it.

This is deliberate. The alternative is unbounded retention, which turns one frozen window
into an out of memory crash for the entire application. A reader that loses its version this
way raises `StaleSnapshotError` on its next decode and recovers by reacquiring.

`OwnerStats.forcedAdvances` counts commits that ran over a pinned reader. A nonzero value in
production means a window is not keeping up, which is a diagnosable condition rather than a
silent one.

## What a reader costs the writer

| Reader state | Effect on the writer |
| --- | --- |
| Not attached | None |
| Attached, not pinned | One atomic load per commit during the table scan |
| Pinned to the current version | Nothing is retained beyond the current version |
| Pinned to an older version | Every version from the pin forward is retained |
| Pinned and frozen | Retention grows to the ring capacity, then forced advance |

## Choosing the retention capacity

| Capacity | Trade |
| --- | --- |
| Small, 16 | Tight memory bound, more forced advances under bursty writes |
| Default, 64 | A reader may lag 64 commits before it fails closed |
| Large, 512 | Tolerant of slow readers, holds proportionally more garbage |

The right number is the number of commits a slow window can fall behind during one frame.
At 60 frames per second and 1000 commits per second, that is about 17, so the default has
roughly a factor of four of headroom.

## Liveness

Readers bump a heartbeat counter on acquire. A reader whose counter has not moved while the
owner heartbeat advanced is a candidate for being declared dead, at which point the owner
force releases its slot and bumps the slot generation. The generation is what makes a
resurrected reader detectable: its snapshots reference a generation that no longer matches.

Declaring readers dead belongs to phase 3, where window lifecycle events give the owner
better evidence than a heartbeat alone.
