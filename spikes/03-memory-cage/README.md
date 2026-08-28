# Spike 03: the V8 memory cage closes the addon route

## Question

Can a native addon map a POSIX shared region and hand it to JavaScript as an `ArrayBuffer`
that genuinely aliases that region?

## Answer

No, on any V8 built with the sandbox and pointer compression enabled, which includes every
Electron since 21 and every recent Node. `napi_create_external_arraybuffer` allocates a
backing store inside the V8 cage and copies your bytes into it. The `ArrayBuffer` that
reaches JavaScript is a snapshot, not a view.

This spike exists so the conclusion is on the record with a reproduction, and so nobody
reopens the question in month four.

## Reproduction

`addon.c` maps a shared region, writes a sentinel, and exposes two functions:

- `wrap()` returns an `ArrayBuffer` created with `napi_create_external_arraybuffer` over
  the mapped pointer.
- `pokeNative(value)` writes `value` into the mapped region through the raw pointer, with
  no JavaScript involvement.

`check.mjs` calls `wrap()`, reads the sentinel, calls `pokeNative` with a new value, and
reads again.

| Outcome | Meaning |
| --- | --- |
| The second read shows the new value | The buffer aliases the region, sharing works |
| The second read still shows the sentinel | The buffer is a copy, the cage rejected the external store |
| The process aborts on `wrap()` | Newer V8 builds fail loudly rather than copying silently |

Every V8 build tested for this project produced one of the last two outcomes.

## Building

The addon needs a C toolchain and `node-gyp`. It is deliberately not wired into continuous
integration, because it is a one time finding rather than a regression to guard.

```bash
cd spikes/03-memory-cage
npx node-gyp configure build
node check.mjs
```

On Windows the `mmap` calls are replaced with `CreateFileMapping` and `MapViewOfFile`. The
result is the same, and the conclusion is not platform specific because the constraint is
in V8, not in the operating system.

## Consequence for the design

The shared region has to be a `SharedArrayBuffer` allocated by V8 itself. That is why the
owner is a renderer rather than the Node main process: renderer to renderer transfer of a
`SharedArrayBuffer` is the one sharing mechanism Chromium supports in production. See
[ADR 0001](../../docs/adr/0001-hidden-owner-window.md).
