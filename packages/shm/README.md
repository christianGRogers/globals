# @bradensbay/globals-shm

The native transport: one file-backed shared memory region, an owning writer that
alternates between two data slots, and reader copies that are always exactly one commit,
through Node-API. This is the layer [ADR 0003](../../docs/adr/0003-native-transport.md)
adopts, and the productionised descendant of
[spike 08](../../spikes/08-mmap-accessor/README.md).

The double buffering is load bearing, and the transport soak is why. A single-slot seqlock
holds its lock for the whole flush copy, so a writer at full rate on a large region leaves
stable windows barely longer than a reader's own copy, and a reader can retry into
livelock; the soak caught exactly that. With two slots, the writer builds each commit in
the slot the last commit did not publish, each slot carries its own sequence and version,
and a reader's copy is torn only if the writer laps into the same slot mid copy, which it
cannot sustain because it must complete a whole further commit first.

## The contract

- **One owner per region.** The process that created the region is the only one that may
  flush. A flush copies the commit's dirty ranges from the owner's private mirror into the
  mapping inside one seqlock section and bumps the version.
- **Readers copy, then decode.** `sync(dest)` produces a copy of the whole data region that
  is one commit and never a torn mixture, and returns the version it belongs to, which under
  a fast writer may be newer than the version observed at the start of the call. `version()`
  is one native call, the fast path a caller checks before deciding to sync.
- **Nothing outside this package touches shared memory.** No ArrayBuffer ever wraps the
  mapping, which is what keeps the V8 memory cage out of the picture. Every byte a caller
  decodes lives in a buffer V8 allocated.
- **Version zero means empty.** A freshly created region has version 0 and undefined data;
  the first flush makes it readable.
- A region file carries a magic number and `LAYOUT_VERSION`; attaching to a foreign file or
  a layout this build does not understand fails closed with a typed error (`ESHM_MAGIC`,
  `ESHM_LAYOUT`). So does a file shorter than the size its own header declares
  (`ESHM_TRUNCATED`), which matters more than it reads: mapping past end of file succeeds on
  POSIX and faults later as `SIGBUS`, a process kill no caller can catch, so a region
  truncated by a full disk or an interrupted copy used to take down every process that
  attached. Misuse fails the same way: `ESHM_BOUNDS`, `ESHM_OWNER`, `ESHM_CLOSED`,
  `ESHM_LIVELOCK`.

## Usage

```ts
import { OwnerRegion, ReaderRegion } from "@bradensbay/globals-shm";

// The owning process, once:
const owner = OwnerRegion.create(path, 1 << 20);
const mirror = new Uint8Array(owner.dataSize);
// ... write a commit into the mirror, then publish the dirty ranges:
owner.flush(mirror, [[0, 64], [4096, 512]]);

// Any other process:
const reader = ReaderRegion.attach(path);
const copy = new Uint8Array(reader.dataSize);
let held = 0;
function read(): Uint8Array {
  if (reader.version() !== held) held = reader.sync(copy);
  return copy;
}
```

## Building

The addon builds with `npm run build:native` at the workspace root, which needs a C
toolchain and Python for node-gyp. The `binding.gyp` lives in `native/` rather than the
package root deliberately, so npm does not auto-build it on every install; prebuilt binaries
are planned before any release (see [plan-native.md](../../docs/plan-native.md), N1).

## Measured behaviour

From spike 08 on the reference machine (macOS arm64, Electron 33): a `version()` call costs
about 14 ns, a 1 MB `sync` about 16 µs, and a real IPC round trip 35 to 40 µs. The
cross-process test in this package holds the same bar the arena's soak does: a writer
flushing at full rate from another OS process, zero torn copies observed.
