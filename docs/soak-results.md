# Soak results

The soak is the release gate for any change to the arena, the allocator, or reclamation.
Results are recorded here with the machine described, so a regression is visible as a
difference rather than a feeling.

```bash
npm run soak                                    # two minutes, eight readers
node packages/core/dist/test/soak/run-soak.js --readers 8 --seconds 3600
```

## What it asserts

| Assertion | Failure means |
| --- | --- |
| Zero inconsistent reads | A reader saw a value that does not match its version id, so the root tag, payload, and version were not read from one commit |
| Zero corrupt decodes | A decode found something a correct writer cannot produce |
| Zero version regressions | A reader observed a version id going backwards |
| No arena growth in the second half | Memory is leaking rather than being reclaimed |

Stale snapshots are counted but not a failure. They are the fail closed path working: a
reader fell past the retention cap and was told so, rather than being handed freed memory.

## Phase 1 exit run

| Field | Value |
| --- | --- |
| CPU | 13th Gen Intel Core i7-13700H, 20 logical cores |
| Operating system | Windows 11, build 10.0.26200, x64 |
| Node | 22.13.1 |
| Date | 2026-08-27 |

```
soak: 8 readers, 300s, 64 retained versions

soak summary

  duration            300.4s
  readers             8
  commits             4846001 (16134/s)
  reads               277484470 (923818/s)
  distinct versions   38052069
  inconsistent reads  0
  version regressions 0
  corruptions         0
  stale snapshots     30
  interned strings    64
  live bytes          1976
  stranded bytes      0
  bump growth, 2nd half 0 bytes

gate: PASS, zero inconsistent reads and no unbounded growth
```

Reading of this result:

- 277 million reads against 4.8 million commits, with zero inconsistent reads. The invariant
  is strong: the committed value is a pure function of its version id, so a torn read of the
  root would show up immediately rather than needing to corrupt something visible.
- Live bytes settled at 1976 and the bump pointer did not move for the last 150 seconds.
  Reclamation is keeping up with a writer running at 16 thousand commits per second.
- 30 stale snapshots across 8 readers over 5 minutes. That is the retention cap doing its
  job when a reader is descheduled at the wrong moment, and it is a recoverable outcome.
- Stranded bytes stayed at zero, so the free lists are absorbing all the churn and there is
  no fragmentation signal yet.

## Phase 2 exit run, with the object layer

Same machine and date. The workload now commits a structured state rather than a scalar, so
the run covers the HAMT, the vector, interning, and both reclamation paths. Most commits are
targeted updates through a draft, and every 512th replaces the root outright so that
retiring a whole structure at once is exercised too.

```
soak: 8 readers, 300s, 64 retained versions

  duration            300.3s
  readers             8
  commits             836002 (2784/s)
  reads               16086350 (53568/s)
  distinct versions   6543791
  inconsistent reads  0
  version regressions 0
  corruptions         0
  stale snapshots     0
  interned strings    136
  live bytes          4944
  stranded bytes      0
  bump growth, 2nd half 0 bytes

gate: PASS, zero inconsistent reads and no unbounded growth
```

Reading of this result:

- Every read decodes the whole structure through `toJSON` and checks seven fields against
  what the version id says they must be. A partial decode could miss a torn subtree that the
  lazy path never touched, so the soak deliberately takes the expensive path.
- Live bytes settled at 4944 and did not move. Structural sharing plus path copy retirement
  is returning exactly what it takes, across 836 thousand commits.
- Interned strings settled at 136 and stopped growing, which is the bounded pool behaving as
  the invariant intends. An unbounded string workload would show here as a climbing number,
  which is the signal that a workload belongs in the asynchronous tier.
- Zero stale snapshots this time. Reads are slower now that each one walks a whole structure,
  so readers acquire less often and never fall past the retention cap.

## Phase 3 chaos run

The chaos harness opens, reloads, freezes, and kills simulated windows while the writer runs
at full rate. Killing a window without a detach is the case that matters: it leaves a claimed
reader slot with a pinned epoch, and nothing in the arena notices on its own.

```
chaos: 8 windows over 12 slots, 90s

  duration            90.9s
  commits             2354002
  reads               1766079
  windows opened      153
  reloaded            185
  closed              56
  killed mid read     89
  frozen              118
  slots reaped        105
  slot exhaustions    0
  inconsistent reads  0
  corruptions         0
  stale snapshots     1001
  claimed slots left  0
  minimum pinned      0
  live bytes          4048
  stranded bytes      0

gate: PASS, no leaked slot, no stuck epoch, no incorrect read
```

Reading of this result:

- 89 windows were killed mid read across 12 slots. Every slot they abandoned was reclaimed:
  none was still claimed at the end, and nothing was still pinned.
- 1001 stale snapshots. Expected and correct. A frozen window keeps a snapshot while the
  writer runs past the retention cap, and the next decode tells it so rather than handing it
  freed memory. That number is the fail closed path being exercised roughly a thousand times.
- Live bytes settled at 4048 despite 105 reaps, so a reaped reader releases exactly what it
  was holding.
- Zero slot exhaustions, with 8 windows churning over 12 slots. The reaper kept up with the
  churn, which is the property that decides whether a real application can open windows
  faster than it closes them.

What this does not cover is the Electron handshake itself: real renderer processes, the
custom protocol, and cross origin isolation. That half is
`packages/electron/test/chaos-app`, run by the electron-matrix workflow, and it has not yet
been run. See [../spikes/RESULTS.md](../spikes/RESULTS.md).

## Phase 5 hardening runs

Same machine. Verified read mode is on by default in the soak, and off in the fuzzer so that
the decoders are what gets exercised rather than the checksum.

### Soak, 8 readers, 180 seconds

```
  commits             460202 (2552/s)
  reads               9347750 (51832/s)
  inconsistent reads  0
  corruptions         0
  stale snapshots     0
  interned strings    136
  live bytes          4944
  stranded bytes      0
  bump growth, 2nd half 0 bytes

gate: PASS
```

### Chaos, 8 windows over 12 slots, 90 seconds

```
  corruptions         0
  stale snapshots     1675
  claimed slots left  0
  minimum pinned      0
  live bytes          4048
  stranded bytes      0

gate: PASS
```

### Fuzz, 20000 rounds

```
  iterations        20000 in 852.1s
  decoded           56356
  typed errors      63644
  untyped errors    0
  slow decodes      0

    ArenaCorruptError        63644

gate: PASS, every decode either succeeded or failed closed with a typed error
```

Run under a 384 MB heap cap on purpose. An unbounded decode shows up as a crash rather than
as a slow test, and a generous cap hides it until continuous integration finds it later. The
heap stayed between 8 and 41 MB throughout.

Reading these results:

- Zero untyped errors across 120 thousand decodes of deliberately corrupted arenas. Every
  failure was an `ArenaCorruptError` raised by a check, not a `TypeError` from dereferencing
  something.
- The 56 thousand successful decodes are not a problem. Corrupting a value slot produces a
  wrong value, which the trust model says is possible and which no amount of validation can
  prevent.
- `strandedBytes` remains zero under every workload measured, so compaction is still not
  called for. See [hardening.md](hardening.md).

## The bug this run exists to prove is gone

An earlier 12 second run reported 2 inconsistent reads in 4.17 million. Forced reclamation
freed memory before raising the reclaim floor, so a reader that was part way through a
decode could return a well formed but wrong value. The fix raises the floor first and
revalidates the snapshot after the decode. See [reclamation.md](reclamation.md).

That is the entire argument for the soak being a gate rather than a task. The bug was
invisible to 65 unit tests, reproduced at a rate of one in two million, and produced a wrong
answer rather than an error.

## The phase 1 exit criterion, restated

The plan asks for twenty four hours with eight readers. The run above is five minutes. The
nightly `soak` workflow runs one hour on three platforms, and a full twenty four hour run
is a release gate rather than a per commit one. The phase is complete when a twenty four
hour run is recorded here.
