# Trust model

Read this before adopting the library. The first sentence is the whole decision:

**A window that reads shared state synchronously runs without the Chromium sandbox.**

Everything else in this document is detail. If your application loads content you do not
fully control into a window that needs synchronous shared reads, this library is the wrong
tool, and no configuration below changes that.

## What the sandbox was buying, and what giving it up means

With `sandbox: true`, a compromised renderer is contained: it holds no OS capabilities
beyond what the broker grants, and an exploited page is a prisoner negotiating through IPC.
With `sandbox: false`, a compromised renderer is a process running arbitrary native code as
the user. Not "can corrupt the app's shared state", but "can read your files and open your
sockets". That is the class of risk, stated at full strength.

Context isolation stays on and the page gets no Node access, so the everyday accident, page
script reaching into Node, is still fenced. The sandbox is the defence against a
compromised renderer, and that is the defence an arena window gives up. The preload, not the
page, holds the transport; treat every arena window's content the way you treat your main
process code, because a renderer exploit in it has similar reach.

## What did NOT get weaker: shared state integrity

The old design's central worry was that shared memory is writable by everyone who maps it.
The native transport removed that property instead of documenting it. A window that attaches
to the region maps it **read only, enforced by the operating system**, and every read it
serves comes from a private copy taken under the region's slot protocol. Only the owner in
the main process can write a byte of shared state.

| A hostile or buggy arena window can | Effect on shared state |
| --- | --- |
| Write to its mapping | It cannot. The mapping is read only; the OS faults the write |
| Corrupt its own private copy | Its own reads go wrong; no other window notices |
| Spam dispatches | The owner applies declared operations or rejects; rate limiting is the app's policy |
| Crash mid read | Nothing. There is no cross process pinning to leak; its copies die with it |

The corruption threats the old model tabulated, garbage roots, wild offsets, poisoned epoch
slots, are not mitigated here; they are unreachable. The decoder's fail closed validation
and the verified read modes remain as defence in depth against owner side bugs, and
`ArenaCorruptError` in the field still deserves investigation, but no window can be its
cause through the region.

## The two tiers

1. **The shared tier**, for windows that render only your own bundled UI. `sandbox: false`,
   context isolation on, synchronous reads through the preload. One trust domain with the
   main process: if you would not let the window's content run in Node, do not put it here.
2. **The asynchronous tier**, for everything else. `sandbox: true`, the shipped
   `preload-async.cjs`, reads by request, writes through the same intent path, and no
   synchronous API exists in that window at all. A third party page, a plugin surface, a
   documentation browser: they keep the full sandbox and never map anything.

The tier is chosen per window by which preload the window gets, and nothing arrives by
default: a window not wired to either tier has no access of any kind.

## What remains your problem inside the shared tier

- A window inside the trust domain can request any declared operation. Declare operations
  narrowly; they are your privilege boundary, exactly like main process IPC handlers.
- Everything in shared state is visible to every window on the shared tier. Put no
  credentials, tokens, or per user secrets in it.
- The sandbox trade compounds with everything else in the window: remote content, dev tools
  exposure, extensions. An arena window should load your bundled files and nothing else.

## Guidance

1. Ship arena windows only for UI you build and bundle. Everything else gets the
   asynchronous tier.
2. Put no secrets in shared state.
3. Declare operations as narrowly as the UI allows; validate payloads in the owner.
4. Treat an `ArenaCorruptError` in the field as a bug to chase, and remember the region
   cannot be its source from a window: look at the owner's side.
