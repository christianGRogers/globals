# The object layer

How ordinary JavaScript state is represented in the arena, and what each operation costs.

## Structures

| JavaScript | Arena representation |
| --- | --- |
| Plain object | HAMT, keys interned strings |
| Array | 32 way trie with a tail buffer |
| `Map` | HAMT, keys any encodable primitive |
| `Set` | HAMT, values ignored |
| `Date` | Eight bytes, epoch milliseconds |
| `RegExp` | Two interned string offsets, source and flags |
| `BigInt` | Sign, byte length, little endian bytes |
| Typed arrays | Kind index, byte length, raw bytes |
| Everything else | Rejected, or an `ExternalRef` into the asynchronous tier |

Both containers are persistent. A write copies the path from the root to the changed node
and shares everything else, which is what makes retaining several versions affordable.

## Cost

Measured, not estimated. The tests in `structural-sharing.test.ts` assert these bounds.

| Operation | Blocks allocated | Notes |
| --- | --- | --- |
| Set a key in an object of 10,000 keys | Under 20 | At most four trie levels, so the path is short |
| Set an element in an array of 10,000 | Under 20 | One path copy, tail writes are cheaper still |
| Set a field two levels deep in 3,000 records | Under 40 | Two paths, one per container on the way down |
| `push` | 2 to 3 | Lands in the tail until the tail fills |
| `pop` | 2 to 3 | |
| `splice`, `sort`, `reverse`, `unshift`, `shift`, `fill`, `copyWithin` | Proportional to length | Cannot be expressed as a path copy |
| Replace the root outright | Proportional to the whole structure | Use `update` unless you mean to replace everything |

The last two rows are the honest part. An array operation that reorders elements rebuilds
the vector, which is linear. That is a property of the structure rather than an oversight,
and the documentation says which operations are which so a hot loop can avoid them.

## Reading

`snapshot.value` returns a lazy view. Reading one property decodes one property, so a table
that renders twenty visible rows out of five thousand pays for twenty.

```ts
const state = snapshot.value as State;
state.users[3].name;        // decodes three nodes, not the user list
snapshot.get(["users", 3, "name"]);  // the same, without building views on the way
snapshot.toJSON();          // the whole structure, detached, no proxies
```

Two things make the laziness safe rather than a trap:

1. Every property access revalidates the version. A view whose version was reclaimed raises
   `StaleSnapshotError` on the next access rather than returning stale bytes.
2. Decoded nodes are memoised per version, and the cache belongs to the snapshot. When the
   root moves the whole cache is unreachable, so a stale entry cannot be served.

Views refuse writes. Assigning to one raises a `TypeError` naming the asynchronous write
path, because the alternative is a silent no op that looks like a bug in the library.

## Writing

```ts
await store.update((draft: State) => {
  draft.users[3].name = "new name";
  draft.count += 1;
  delete draft.stale;
});
```

The draft is a proxy in the style of immer. Reading through it costs nothing at commit time,
and only the paths you touched are rebuilt. A recipe that changes nothing does not publish a
version, so it does not wake every window.

A recipe that throws leaves the published version untouched and releases everything the
partial encode allocated.

### What a draft deliberately does not do

Drafts do not alias. Assigning a value you read out of the store into a second position
encodes a copy rather than sharing nodes:

```ts
await store.update((draft: State) => {
  draft.backup = draft.current;  // copies, does not share
});
```

Sharing would need reference counting to reclaim correctly, and every write in every
application would pay for it to support a case almost none of them have. The rule is one
sentence and the cost is visible, which is better than a subtle reclamation bug.

## Keys

Object keys are interned strings, so the writer compares them with an integer compare. A
reader cannot intern, because interning is a write, so it walks the trie by hash and compares
characters against the single record it lands on. Both are logarithmic.

Map and set keys may be any encodable primitive: string, number, boolean, `null`, or
`undefined`. Comparison is SameValueZero, so `NaN` matches `NaN` and an integral double
matches the integer equal to it.

Objects are rejected as keys. Object identity does not survive a process boundary, so a map
keyed on an object would be a map nobody could look anything up in. Rejecting it is better
than encoding something that silently never matches.

## The escape hatch

Values outside the ladder go to the asynchronous tier through a visibly different API.

```ts
const handle = tier.put(somethingUnencodable);
await store.update((draft) => { draft.attachment = handle; });

// Anywhere, later. Asynchronous in every process, including the owner.
const value = await tier.get(snapshot.attachment);
```

`get` is asynchronous even in the owner, which holds the value already. That is deliberate:
moving code between the owner and a window must not change whether it compiles.

## Layout notes

A HAMT node carries an explicit kind word. It costs four bytes per node and buys two things:
collision nodes are distinguishable without stealing a bitmap value, and a wild offset that
happens to land on plausible bitmaps is rejected rather than walked. Every node also carries
the allocator block header, so a decode validates the block before it reads a single field.
