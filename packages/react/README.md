# @globals/react

The react binding for [Globals](https://github.com/christianGRogers/globals).

Full guide: [docs/bindings.md](../../docs/bindings.md).

## The point

Reads are synchronous. A render can call `get()` on the line it needs the value, with no
`await` and no replicated copy of state in the window.

Writes are asynchronous, and the return type says so.

## Equality

The default is `Object.is`, which is right for a scalar and wrong for a container. Every
commit builds a fresh decode cache, so a selector returning a nested object returns a new
proxy each time and notifies on every commit.

For a container, use the node comparing variant. An untouched subtree keeps its arena node
across commits, so it notifies only when the subtree actually changed. The reasoning behind
why comparing offsets is sound is in [docs/bindings.md](../../docs/bindings.md).
