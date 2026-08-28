# Security policy

## Reporting

Report a suspected vulnerability through GitHub private vulnerability reporting on this
repository. Do not open a public issue for a vulnerability. Expect an acknowledgement
within seven days.

## Threat model summary

This library maps one `SharedArrayBuffer` into several renderer processes. Shared memory
is writable by every process that holds it, so the arena is a single trust domain. A
window that can map the arena can corrupt the state that every other window reads.

The full analysis, including what the design does and does not mitigate, is in
[docs/trust-model.md](docs/trust-model.md).

## In scope

- A decode path that dereferences an attacker controlled offset instead of failing closed.
- A reclamation bug that lets a reader observe freed or recycled memory as valid state.
- A bootstrap path that hands the buffer to a window that opted out of the shared tier.
- A checksum verification that can be defeated by a writer inside the arena.

## Out of scope

- A window inside the declared trust domain writing bad values into the arena. That is the
  documented consequence of mapping shared memory, and the mitigation is the per window
  opt out, not a code change.
- Disabling `sandbox` or `contextIsolation` in your own application and then reporting the
  consequences.

## Supported versions

Until 1.0.0, only the latest minor receives fixes.
