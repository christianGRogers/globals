# Stability

What this project promises about compatibility, and what it does not.

## Current status

**Pre-release, on the native transport.** The original design, a `SharedArrayBuffer` shared
through web platform channels, failed its feasibility gate finally and for a reason in the
HTML specification; [../spikes/RESULTS.md](../spikes/RESULTS.md) holds the measurements and
[adr/0003-native-transport.md](adr/0003-native-transport.md) the decision that replaced it.
What ships now is the native transport: a Node-API addon, one mapped region, the owner in
the main process, and the trade the trust model leads with.

## What the library depends on, and how exposed each dependency is

The old design lived and died by Electron internals: serializer behaviour on
`MessageChannelMain`, isolation headers on a privileged scheme, process allocation for
related windows. The native transport's surface is deliberately smaller and better
guaranteed:

| Dependency | Guarantee |
| --- | --- |
| Node-API | ABI stable by contract across Node and Electron versions; the same binary serves all of them |
| `mmap` and `CreateFileMapping` | Operating system interfaces, stable for decades |
| `sandbox: false` remaining available for a window | The one Electron policy this design cannot survive losing; watched, not assumed |
| ESM preloads in unsandboxed windows | Electron 28 and later |
| `contextBridge`, `ipcRenderer.invoke` | Ordinary stable Electron API |

The beta canary in the `electron-matrix` workflow runs the native gates against every
upcoming major, so a change to any of these is a warning before it is a release note.

## Supported Electron range

| Electron | Status |
| --- | --- |
| 27 and earlier | Not supported. ES modules in the main process arrived in 28. |
| 28 to 41 | Expected to work, not covered by continuous integration |
| 42, 43, 44 | Covered by the native gates in the `electron-matrix` workflow |
| Newest prerelease | Run as a canary that warns rather than breaks |

The gated three are whichever majors Electron itself supports, which is always the latest
three. When Electron ships a major, the matrix moves up and the peer range's upper bound
moves with it, in the same change. Older majors are not dropped from the peer range,
because nothing is known to have broken on them; they simply stop being proven.

## Versioning

Semantic versioning, with two layout versions underneath it.

**The arena layout** (`LAYOUT_VERSION` in `@bradensbay/globals-core`) and **the region layout**
(`LAYOUT_VERSION` in `@bradensbay/globals-shm`) are each stored in their headers, and a reader refuses
to attach to a layout it does not understand. That matters because an owner and a reader can
be different builds inside one application if a window is not reloaded across an update.
Either layout changing is a major version change, never a patch.

**The contract is not going to change.** Reads are synchronous and writes are asynchronous.
Anything that would blur that is out of scope regardless of how convenient it would be. See
[contract.md](contract.md).

## What is covered by semantic versioning

| Covered | Not covered |
| --- | --- |
| The exported API of every package | The arena and region byte layouts, which have their own versions |
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

- [ ] The native gates green on every supported Electron major, on all three platforms
- [ ] The window lifecycle chaos harness green on all three platforms
- [ ] A twenty four hour soak, arena and transport both, recorded
- [ ] The trust model reviewed by someone outside the project who agrees it is honest about
      the sandbox trade
- [ ] A non trivial application built by someone who did not write the library, using only
      the published documentation
- [ ] The read latency benchmarks reproduced on hardware that is not the author's
