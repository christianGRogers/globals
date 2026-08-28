# @globals/core

The runtime agnostic core of [Globals](https://github.com/christianGRogers/globals): one
shared memory arena, a tagged value encoding, an allocator, and epoch based reclamation.

Nothing in this package imports Electron. That is deliberate, and it is what makes the arena
testable in plain Node with worker threads.

## Contract

Reads are synchronous. Writes are asynchronous. See
[docs/contract.md](../../docs/contract.md).

## Usage

```ts
import { ArenaOwner, ArenaReader } from "@globals/core";

// In the owner, the only process that writes.
const owner = ArenaOwner.create({ byteLength: 1 << 20 });
owner.commit(42);

// In any process that holds the same buffer.
const reader = ArenaReader.attach(owner.buffer);
reader.read(); // 42, synchronously

// Hold a version across several reads so they cannot disagree.
const snapshot = reader.acquire();
snapshot.value;
snapshot.release();

reader.detach();
```

## Type ladder

This package encodes the scalar rung: `number`, `string`, `boolean`, `null`, and
`undefined`. Objects, arrays, and the rest of the ladder arrive with the object layer.
Anything unencodable raises `UnencodableValueError` rather than being silently coerced.

## Errors

| Error | Meaning |
| --- | --- |
| `StaleSnapshotError` | The version you held was reclaimed. Reacquire. |
| `ArenaCorruptError` | A decode found something a correct writer cannot produce. |
| `ArenaFullError` | The arena is exhausted and cannot grow. |
| `NoReaderSlotError` | Every reader slot is claimed. |
| `UnencodableValueError` | The value is outside the type ladder. |

## Testing

```bash
npm test          # unit, property, and fail closed tests
npm run soak      # multi process soak, the release gate for arena changes
npm run bench     # the read latency harness
```
