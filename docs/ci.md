# Continuous integration

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci` | Every push and pull request | Native addon build, typecheck, tests, documentation checks, the Node runnable spikes, and short soak, chaos, fuzz, and transport soak runs |
| `soak` | Nightly at 03:00 UTC and on demand | The long arena soak, chaos, fuzz, and the hour long transport soak across real processes |
| `electron-matrix` | Weekly, on demand, and on transport or integration changes | The native gates, spike 08, the e2e app, and window lifecycle chaos, per Electron major and platform; spike 01 as a verdict change detector; a canary on the newest prerelease for both |
| `codeql` | Push, pull request, weekly | Static analysis, JavaScript and the native addon's C |
| `release` | A `v*` tag | Verifies the tag sits on `main` and matches the package version, then publishes |
| `prebuilds` | Transport native changes on `dev`, and on demand | Builds and smoke tests the addon on all six platform and architecture pairs |

### Jobs in `ci`

| Job | What it proves |
| --- | --- |
| `docs` | House style and link integrity across every markdown file |
| `build` | The workspace builds and every test passes, on three platforms and two Node majors |
| `spikes` | The atomics protocol and the read latency assumption still hold |
| `smoke-soak` | Ninety seconds of soak, sixty seconds of chaos, and 1200 fuzz rounds |

The short runs in `smoke-soak` are deliberately short. They catch a change that breaks the
arena outright. They do not catch a race that shows up once in a million reads, which is what
the nightly runs are for.

`ELECTRON_SKIP_BINARY_DOWNLOAD` is set on `ci` and `soak`. Those jobs need the Electron types
to typecheck the integration package and never run Electron itself, so downloading a hundred
megabyte binary on every job in a six way matrix would cost minutes for nothing. The
`electron-matrix` workflow installs it properly where it is actually used.

## The matrix and why it is wide

The build job runs on Linux, macOS, and Windows, on Node 20 and 22. The core has no
Electron dependency, so this matrix is about the arena behaving identically on three memory
models and two Node majors.

The Electron matrix is separate and slower. This library is unusually exposed to Electron
internals, so each supported major is exercised rather than assumed. The beta canary uses
`continue-on-error`, because a failure there is early warning rather than a broken build.

## What blocks a merge

| Check | Blocking |
| --- | --- |
| `documentation` | Yes |
| `build and test` on all six combinations | Yes |
| `phase 0 spikes` | Yes |
| `codeql` | Yes |
| `soak`, the nightly one | Not automatically, but a change to the arena or reclamation needs a soak result pasted into the pull request |
| `electron-matrix` | Yes for changes under `packages/electron` |

## Release flow

Releases are not automatic.

1. Cut `release/x.y.z` from `dev`, bump versions, update `CHANGELOG.md`.
2. Merge the release branch back into `dev`.
3. The repository owner merges the release branch into `main` and pushes the `vx.y.z` tag.
4. The `release` workflow verifies the tag is an ancestor of `main` and matches the package
   version, then publishes with npm provenance.

The verification step exists because a tag pushed from a feature branch would otherwise
publish unreviewed code.

## Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `NPM_TOKEN` | `release` | Scoped to publish only, held in the `npm` environment so a release needs an approval |

No other workflow needs a secret. `GITHUB_TOKEN` permissions are set to the minimum each job
needs, and `contents: read` is the default.
