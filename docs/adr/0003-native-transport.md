# ADR 0003: The native transport

- Status: accepted
- Date: 2026-08-28
- Relates to: [ADR 0001](0001-hidden-owner-window.md), [ADR 0002](0002-window-open-handshake.md)

## Context

Phase 0 closed every web platform route. The HTML agent cluster rule keeps a
`SharedArrayBuffer` inside one cluster, clusters never span the process boundary the design
needed to cross, and the spike 07 rerun measured that no header, privilege, feature flag, or
Chromium version changes it. The gate failed, finally.

Spike 08 then measured the route the web APIs cannot offer: a file-backed region mapped into
the main process and into renderer processes by a Node-API addon, read through native
accessor calls so the V8 memory cage never sees a foreign pointer. Cross process visibility
held in both directions, a writer at full rate produced zero torn reads, an accessor call
costs 14 ns against a 35 µs IPC round trip, and a seqlock-consistent copy of the whole 1 MB
region costs 16 µs. The price is `sandbox: false` on every window that maps the region.

## Decision

Adopt the native transport, structured as copy on commit rather than decode in place:

- **The owner lives in the main process** (optionally a `utilityProcess`), running the
  existing core `OwnerStore` over a private ArrayBuffer. On commit it flushes the dirty
  range into the mapping through the addon and bumps the shared version under the seqlock.
- **A reader window syncs, then decodes locally.** On every read: one native version check
  (14 ns); if the version moved, one seqlock-consistent copy into a private in-cage
  ArrayBuffer (16 µs per MB, only on commit); then the existing decoder runs unchanged over
  stable private memory. A read can never observe a stale version and never a torn one.
- **The per window tier split survives.** A window that keeps `sandbox: true` gets the
  asynchronous replicated tier that already exists. Only windows that map the arena run
  unsandboxed, and the trust model leads with that sentence.

## Consequences

- **The hard problems get easier.** Cross process epoch reclamation, the liveness monitor,
  and forced reclaim exist because readers decoded the owner's memory in place. With copy on
  commit, a reader's snapshot lives in its own buffer and ordinary garbage collection
  replaces the epoch protocol across processes. The core keeps those mechanisms for the
  worker-thread topology where true shared decoding still applies.
- **Most of the Electron package is deleted.** The hidden owner window, the privileged
  scheme, the COOP and COEP serving, and the `window.open` handshake all exist to move a
  buffer the platform refuses to move. The owner being a plain main-process object also
  simplifies persistence and removes the owner's window lifecycle entirely.
- **Crash isolation returns.** Windows live in separate OS processes again; a window crash
  cannot take the owner or its siblings, which the single process topology could not offer.
- **The exposure surface shrinks.** The design no longer depends on Electron serializer
  internals or isolation header behaviour. Node-API is ABI stable across Electron majors.
  The new exposure is `sandbox: false` remaining available and prebuilt binaries per
  platform and architecture.
- **The claim changes.** Synchronous shared reads across processes, for applications
  prepared to run their arena windows without the Chromium sandbox. That sentence goes at
  the top of the README, the trust model, and the migration guide.
- The `MAP_FIXED` remap experiment stays behind a flag as a possible post-1.0 optimisation,
  never the foundation.

## What would change this decision

An external reviewer concluding the sandbox trade cannot be stated honestly for the intended
audience, spike 08 failing on Windows or Linux, or Electron removing `sandbox: false`. The
fallback is the single process repositioning measured by spike 05, which keeps the sandbox
and gives up crash isolation instead.
