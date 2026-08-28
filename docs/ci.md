# Continuous integration

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci` | Every push and pull request | Build, typecheck, tests, documentation checks, the Node runnable spikes |
| `soak` | Nightly at 03:00 UTC and on demand | The multi process soak that gates arena changes |
| `electron-matrix` | Weekly, on demand, and on `packages/electron` changes | Spike 01 across supported Electron majors and platforms, plus a beta canary |
| `codeql` | Push, pull request, weekly | Static analysis |
| `release` | A `v*` tag | Verifies the tag sits on `main` and matches the package version, then publishes |

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
| `soak` | Not automatically, but a change to the arena or reclamation needs a soak result pasted into the pull request |
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
