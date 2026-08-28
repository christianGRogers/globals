# Framework bindings

Three adapters over one pair of methods: `subscribe` and a synchronous snapshot. They are
thin on purpose, because the interesting work is below them.

## React

```tsx
import { StoreProvider, useSelector, useNodeSelector, usePath } from "@globals/react";

<StoreProvider store={connection}>
  <App />
</StoreProvider>;

function Header() {
  const title = usePath<string>(["title"]);
  const count = useSelector((state) => (state as State).rows.length);
  return <h1>{title} ({count})</h1>;
}
```

This is the headline feature. `useSyncExternalStore` asks for a synchronous snapshot, and
Electron applications have not been able to supply one without keeping a replicated copy of
state in every window.

| Hook | Use it for |
| --- | --- |
| `usePath` | A leaf value. Walks the arena directly, builds no intermediate views. Cheapest. |
| `useSelector` | A computed scalar. Compared with `Object.is`. |
| `useNodeSelector` | A container. Compared by the arena node behind it. |
| `useGlobalState` | The whole state. Rerenders on every commit, so use it deliberately. |
| `usePinnedSnapshot` | A component that must see one version across several reads. |

## Vue

```ts
import { installStore, usePath, useSelector } from "@globals/vue";

installStore(app, connection);

const title = usePath<string>(["title"]);
const count = useSelector((state) => (state as State).rows.length);
```

`shallowRef` rather than `ref`, deliberately. Deep reactivity would walk the state proxy and
decode every property to install tracking, which is the opposite of what a lazy view is for.

## Svelte

```svelte
<script>
  import { path, selectedNode } from "@globals/svelte";
  const title = path(store, ["title"]);
  const user = selectedNode(store, (state) => state.user);
</script>

<h1>{$title}</h1>
```

The Svelte store contract is one method, so the adapter needs no Svelte import at all and
works with versions 4 and 5 from one build.

## The equality question, which decides how much you rerender

The default equality is `Object.is`. That is right for a scalar and wrong for a container,
and the reason is worth understanding rather than working around.

Every commit produces a new snapshot with a fresh decode cache. A selector that returns a
nested object therefore returns a new proxy every time, even when the subtree behind it did
not move a byte. Under `Object.is` that is a change, so the component rerenders on every
commit.

`useNodeSelector`, `selectedNode`, and the exported `sameNode` compare the arena node instead:

```ts
const user = useNodeSelector((state) => (state as State).user);
```

An untouched subtree keeps its arena node across commits, so this rerenders only when the
subtree actually changed.

### Why comparing offsets is sound

It looks like it should not be, since the allocator reuses freed blocks. A commit encodes the
new value before it frees anything the old version held, so a newly written node can never
land on the block the current version is using. The value a selector last saw is the current
version's node, so a later node reusing that block always compares unequal to it. The
comparison dereferences nothing, so a corrupt offset cannot make it misbehave either.

It compares representation rather than value. Two structurally equal subtrees written
separately are different nodes and compare unequal, which is the conservative direction: an
extra render, never a missed one.

## Choosing between the three read shapes

| Shape | Cost | When |
| --- | --- | --- |
| `store.select(path)` | One walk, no views built | A leaf value, and the render loop |
| `store.get()` then property access | One view per node touched | Reading several fields of one object |
| `snapshot.toJSON()` | The whole structure | Handing state to something that must own it |

A table rendering twenty visible rows out of five thousand should read through the lazy view
and touch only what it renders. That is the case the object layer is shaped for.

## Writes

Writes are asynchronous in every binding, and the return type says so:

```ts
await store.dispatch("rename", { id, name });
```

There is no hook for writing, on purpose. A write is not a render concern, and a hook that
looked like `useWrite()` would invite calling it during render.
