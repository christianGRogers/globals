# Spike 02: atomics torture

## Question

Do `Atomics.load`, `Atomics.store`, and `Atomics.compareExchange` behave across separate
execution contexts that share one `SharedArrayBuffer`, and would this test detect broken
memory ordering if it existed?

## What it does

Three checks, each designed to fail loudly rather than quietly produce a plausible number.

### 1. Contended counter

N workers each perform a fixed number of `compareExchange` increments on one slot. The final
value must equal `workers * increments` exactly. A lost update, which is what a broken
compare and exchange produces, shows up as a shortfall.

### 2. Message passing ordering

The classic store buffer test. A writer fills a payload region with a known pattern, then
publishes a sequence number with a release store. A reader loads the sequence number with an
acquire load and, if it sees the new sequence, asserts that the whole payload is the new
pattern. Observing a new sequence number next to a stale payload byte is a memory ordering
violation. The test runs for a fixed duration and counts violations.

### 3. Seqlock under a writer at full rate

The root and epoch handshake in the real design is guarded by a seqlock. This check runs
that exact protocol: an odd sequence means a write is in progress, readers retry, and a
successful read must observe a self consistent record. Any torn record is a failure.

## Interpreting a result

`violations: 0` over a run of a few hundred million reads is evidence, not proof. The value
of the test is the reverse: a nonzero count is proof that the protocol as written cannot be
built on this runtime. That is exactly what a gate needs.

## Running

```bash
node spikes/run-spike.mjs 02
node spikes/run-spike.mjs 02 -- --workers 8 --seconds 20
```
