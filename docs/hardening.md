# Hardening

What was done to make this dependable, what it does not cover, and how to check it yourself.

## The security note

This section is the one a reviewer should read first, and it says the uncomfortable thing
plainly rather than burying it.

**A shared buffer is writable by every process that holds it.** There is no read only
mapping and no per window permission on the bytes. Any window that maps the arena can write
anywhere in it, including the header, the root pointer, and the allocator metadata. That
partially undoes what `sandbox: true` buys you: the sandbox contains a compromised renderer
inside its own process, and it does not contain writes to memory that renderer legally holds.

No amount of engineering removes this. The three responses are a documented trust domain, a
per window opt out, and a verified read mode, and they are described in
[trust-model.md](trust-model.md). None of them is a fix, because there is no fix.

**What the verified read mode is.** The owner publishes a checksum over the header and the
root with each commit, and a reader checks it when it acquires a new version. It detects
corruption by a buggy window, or by a hostile window that does not also forge the checksum.
It does not detect a window that computes a valid checksum for corrupt data, because that
window has exactly the information the owner has. This is a corruption detector, not a
message authentication code, and describing it as one would be a claim a reviewer would
rightly reject.

**Verification is per version, not per read.** A reader that already holds a version does not
re-verify it, which is what makes the mode affordable. Corruption introduced after a reader
acquired a version is caught at that reader's next acquisition, not before.

| Mode | Detects | Misses | Cost |
| --- | --- | --- | --- |
| `off` | Nothing | Everything | Zero |
| `header` | A rewritten root, version, or generation | A corrupt leaf value, a forged checksum | One hash of a dozen words per version |
| `full` | Any change to the reachable set | A forged checksum | One walk of the structure per version |

`header` is the default. `full` is for diagnosing corruption, not for production: it is linear
in the size of the state on every commit.

## Fail closed decoding

Every decode path validates before it dereferences. An offset is checked for alignment, for
being inside the arena region, and for carrying a valid block header, and every record checks
its own length field against the block it claims to live in.

The fuzzer exists to check that this is true rather than intended. It builds a realistic
arena, corrupts it at random, and decodes it. The requirement is not that decoding succeeds:

```bash
node packages/core/dist/test/fuzz/run-fuzz.js --iterations 20000
```

| Outcome | Verdict |
| --- | --- |
| The value decoded | Fine. Corruption of a value slot produces a wrong value, which the trust model says is possible. |
| A typed error from this library | Fine. That is fail closed working. |
| Any other error | Failure. A `TypeError` or a `RangeError` means a check was missing. |
| A decode that hangs | Failure. |

### What the fuzzer found

The fuzzer's first real run did not report a failure. It ran the process out of memory, which
is a less convenient result and a more useful one: it meant something was decoding a corrupt
arena into an unbounded amount of work.

Diagnosing it took three wrong guesses before the right answer, which is worth recording
because the wrong guesses were all plausible and all cost time. The thing that ended the
guessing was making the fuzzer write its round index synchronously before each round, so the
crash named its own case. That option is still there:

```bash
node packages/core/dist/test/fuzz/run-fuzz.js --iterations 20000 --trace trace.txt
node packages/core/dist/test/fuzz/run-fuzz.js --iterations 4597 --inspect 4596 --dump case.bin
```

The actual cause was **an unvalidated entry count on a collision node**. A bitmap node stores
its occupancy as two bitmaps, so its entry count can never exceed 32 whatever is written
there. A collision node stores a plain integer, nothing checked it against the block that
holds it, and every walker trusted it. A corrupted count sent them off to visit two billion
entries with no bound inside the loop. It is validated now, the same way the bitmap node
always was.

Four more problems came out of the same investigation. Being precise about which is which
matters, because saying the fuzzer found five bugs would overstate what happened.

**The first crash was the fuzzer's own defect.** It built a fresh arena per round, so every
round allocated another `SharedArrayBuffer` and twenty thousand of them exhausted the heap.
It was crashing on its own bookkeeping and reporting that as a library failure, which is
worse than not running at all. It now restores a template into one reusable buffer, and the
heap stays flat across twenty thousand rounds.

**A quadratic bigint decode.** `decodeBigInt` built its value by shifting one byte at a time,
allocating a new bigint per byte, each longer than the last. A corrupt length of a quarter
megabyte churned tens of gigabytes. It goes through a hex string now, which is linear.

The last two came from auditing unbounded paths rather than from a case that hit them. They
are real, and being honest about how they were found is worth more than a tidier story.

**A corrupt element count on a vector.** A count of two billion sent the decoder off to build
an array of two billion elements. The count is now rejected when it exceeds what the buffer
could physically hold, since every element occupies at least one eight byte slot.

**A depth bound is not enough for a trie.** A corrupt child pointer can make a node point at
an ancestor. Bounding depth at eight levels stops the recursion but still allows thirty two
to the eighth visits, because each level fans out. Traversal now carries a total budget
derived from the buffer size as well as the depth bound, and decoding carries a budget
measured in units of output, because a corrupt graph materialises a shared subtree once per
reference.

There was also a bug in the verification feature itself, caught by the soak rather than the
fuzzer, within a minute of the feature landing. The reader loaded the published checksum
after validating the root under the seqlock, so a commit landing in between made it compare a
checksum from one version against a root from another: roughly fifty false corruption reports
in eight hundred thousand reads. The checksum is now read inside the seqlock window with the
root it belongs to.

That last one is worth dwelling on. A security feature that cries wolf at that rate is worse
than no feature, because it trains people to ignore it.

## The transport fails closed too

The decoder's fail closed discipline was written for the arena. The transport did not have
it, and the gap was not academic.

**A truncated region file killed the process.** Attach read the data size out of the header
and mapped that many bytes without checking the file was that long. Mapping past end of file
succeeds on POSIX; the fault arrives later, when a reader touches the page, as `SIGBUS`. That
is a process kill, not an error any caller can catch and not something `ESHM_*` can report,
so a region left short by a full disk or an interrupted copy took down every process that
attached. It was reproduced as a crash before it was fixed. Attach now measures the file and
refuses with `ESHM_TRUNCATED`, and a declared size that could not be mapped at all is refused
as `ESHM_LAYOUT`.

**A failed allocation could brick a region permanently.** The buffer holding the previous
commit's ranges was grown inside the seqlock section, after the slot sequence had been made
odd. An allocation failure returned with it left odd, and the next flush read that odd value
and stored `sseq + 1`, inverting the convention: from then on the sequence was even while the
writer was inside a slot and odd while it was settled. Every reader's bracket read saw a
writer in a slot nothing was writing, spun its whole budget, and returned `ESHM_LIVELOCK`.
One transient failure, and the region never worked again. The allocation happens before the
section now, where failing is ordinary.

**Two bounds were bounds on the wrong quantity.** `sync` counted attempts rather than time,
so its cap allowed minutes of a frozen window before the error arrived; it holds a deadline
now. The path buffer was fixed at 2048 bytes, and `napi_get_value_string_utf8` reports success
when it truncates, so an over-long path opened a different file rather than failing.

**Non-ASCII Windows paths could not be opened at all.** The region file lives under
`userData`, which contains the account name, and the ANSI entry points cannot express a path
outside the active code page. Anyone whose account name carries an accent or is written in a
non-Latin script got `ESHM_IO` at startup with nothing to explain it. The path is UTF-16
throughout now.

### What reads the C mechanically

| Check | Covers | Runs |
| --- | --- | --- |
| CodeQL `c-cpp` | The addon, with the compiler observed | Push, pull request, weekly |
| AddressSanitizer, UndefinedBehaviorSanitizer | Region tests, cross process tests, and a twenty second soak | Every `ci` run |

The sanitizer job is worth reading the caveats on. Node is not built with sanitizers, so leak
detection is off: only faults in the addon's own code are being asked about. The soak under
ASan has run 82,219 commits and 35,300 reads with zero torn copies and no sanitizer report.

**ThreadSanitizer is not used, and the reason is not effort.** It finds races between threads
inside one process. This transport's concurrency is between separate processes sharing a
mapping, which TSan cannot observe at all, so it would report clean while proving nothing.
The evidence for the memory ordering remains the cross process soak, and that evidence is
statistical: many commits, no tear seen. It is a strong result and it is not a proof.

## Exhaustion and fragmentation

| Situation | Behaviour |
| --- | --- |
| A write does not fit and the arena can grow | It grows, up to `maxByteLength` |
| A write does not fit and it cannot grow | `ArenaFullError`, and the previous version is untouched |
| A rejected write | Everything it allocated is released, the strings it interned are forgotten, and the bump pointer is rewound to where it was |
| A block larger than the biggest size class is freed | Dropped rather than tracked, and counted in `strandedBytes` |
| Reader slots exhausted | `NoReaderSlotError`, and the arena keeps working |

**The rollback is not just freeing.** Freeing returns blocks to their size classes, and the
allocator has no coalescing, so an arena that a failed write filled with sixteen byte string
records could not then serve a forty byte request. It would be stuck until restarted. So a
rejected write also rewinds the bump pointer past everything it allocated, which is safe
because there is one writer, a commit is synchronous, and nothing published can reference a
block above the mark.

That closes a real exhaustion vector. Without it, a window that can request writes could
consume the arena permanently with writes that were all refused, because interned strings are
never freed during normal operation.

**Compaction is not implemented.** The plan says to add it if the soak data calls for it, and
so far it does not: `strandedBytes` stays at zero under the churning workloads measured, and
utilisation stays above 75 percent. `strandedBytes` climbing over time in a real application
is the signal that the answer has changed. See [soak-results.md](soak-results.md).

## The support matrix

This library is unusually exposed to Electron internals, so the matrix is not optional.

| Axis | Covered |
| --- | --- |
| Operating system | Linux, macOS, Windows |
| Architecture | x64 on all three, arm64 on macOS runners; prebuilds cover arm64 on all three |
| Node | 20 and 22 |
| Electron | 42, 43, 44, plus a canary on the newest prerelease that warns rather than breaks |

The core has no Electron dependency, so its matrix is about the arena behaving identically on
three memory models. The Electron matrix is separate, slower, and scheduled.

## Running the checks yourself

```bash
npm test                 # unit, property, corruption, and exhaustion tests
npm run soak             # multi process soak, the release gate for arena changes
npm run chaos            # windows opened, reloaded, frozen, and killed
node packages/core/dist/test/fuzz/run-fuzz.js --iterations 20000
npm run bench            # the read latency harness
```

## What is still outstanding

Stated here rather than left for a reader to discover. The measurements this section once
waited on have since been made: the buffer sharing spikes ran, closed the web platform route
for the reason recorded in [../spikes/RESULTS.md](../spikes/RESULTS.md), and the library now
ships on the native transport of [adr/0003-native-transport.md](adr/0003-native-transport.md),
whose e2e and window lifecycle chaos gates run and pass on real windows. What remains:

- **This note predates the native transport in places.** Its corruption analysis assumed
  every window can write shared memory; on the native transport everyone but the owner maps
  the region read only, and the binding threat moved to the sandbox trade the
  [trust model](trust-model.md) now leads with. The full rewrite is tracked in
  [plan-native.md](plan-native.md).
- **The twenty four hour soak has not been run.** The longest recorded runs are one hour
  nightly, arena and transport both, on three platforms in continuous integration.
- **No external reviewer has read the trust model.** The 1.0 checklist asks for one who
  agrees it is honest about the sandbox trade, and that has not happened.
