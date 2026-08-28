# Stability

What this project promises about compatibility, and what it does not.

## Current status

**The feasibility gate has failed. Nothing here should be adopted for the purpose the project
was started for.**

A `SharedArrayBuffer` does not cross a renderer process boundary in Electron 33 by any
mechanism measured. See [../spikes/RESULTS.md](../spikes/RESULTS.md) for the measurements and
[adr/0002-window-open-handshake.md](adr/0002-window-open-handshake.md) for what it means.

The core package is a different matter. It is runtime agnostic, it has no Electron dependency,
and it is tested to the standard the plan asked for. It survives into whichever off ramp the
project takes.

## Supported Electron range

| Electron | Status |
| --- | --- |
| 27 and earlier | Not supported. ES modules in the main process arrived in 28. |
| 28 to 30 | Expected to work, not covered by continuous integration |
| 31, 32, 33 | Covered by the `electron-matrix` workflow |
| Beta | Run as a canary that warns rather than breaks |

The range is narrow because this library is unusually exposed to Electron internals. It
depends on renderer to renderer `SharedArrayBuffer` transfer, on `MessageChannelMain`, and on
`protocol.handle` being able to set the isolation headers. Any of those can change in a way
that a version number does not advertise.

## What happens when a new Electron major lands

1. The canary job fails or warns on the beta, which is the earliest signal available.
2. Spike 01 runs against the new major, because it answers the question that matters: does
   the buffer still reach a sandboxed renderer.
3. If it passes, the major is added to the matrix and the range in this document widens.
4. If it fails, this document says so before anyone finds out by upgrading.

A major that breaks the bootstrap handshake is a known risk with a named mitigation rather
than a surprise. It is in the risk register in [plan.md](plan.md).

## Versioning

Semantic versioning, with two additions specific to this library.

**The arena layout has its own version.** `LAYOUT_VERSION` is stored in the header, and a
reader refuses to attach to a buffer whose layout it does not understand. That matters
because an owner and a reader can be different builds inside one application if a window is
not reloaded across an update.

A layout change is always a major version change, and never a patch.

**The contract is not going to change.** Reads are synchronous and writes are asynchronous.
Anything that would blur that is out of scope regardless of how convenient it would be. See
[contract.md](contract.md).

## What is covered by semantic versioning

| Covered | Not covered |
| --- | --- |
| The exported API of every package | The arena byte layout, which has its own version |
| Error types and when they are raised | Error message wording |
| The contract and the consistency model | Performance, though a regression over 20 percent is treated as a break |
| The behaviour of documented options | Internal module paths not re-exported from the package root |

## Deprecation

A deprecated export keeps working for one minor release and warns once per process. A removal
happens in a major.

## Support

Until 1.0.0, only the latest minor receives fixes. There is no long term support branch and
there will not be one before there is a 1.0.0.

## What has to be true before 1.0.0

Stated as a checklist rather than a date, because the date depends on things that have not
been measured yet.

- [ ] Spike 01 passes on every supported Electron major, on all three platforms
- [ ] The Electron chaos harness passes on all three platforms
- [ ] A twenty four hour soak with eight readers, recorded
- [ ] The security note reviewed by someone outside the project
- [ ] A non trivial application built by someone who did not write the library, using only
      the published documentation
- [ ] The read latency benchmark reproduced on hardware that is not the author's
