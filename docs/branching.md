# Branching model

The repository uses a gitflow variant. Branches are never deleted after merge, so the
history of each phase stays inspectable.

## Long lived branches

| Branch | Role | Who merges into it |
| --- | --- | --- |
| `main` | Released, tagged code only | The repository owner, by hand |
| `dev` | Integration branch, always buildable | Every feature, release, and chore branch |

Automation and contributors merge into `dev`. Nothing merges into `main` except a release
branch, and that merge is performed by the repository owner.

## Short lived branches

| Prefix | Branches from | Merges into | Purpose |
| --- | --- | --- | --- |
| `feature/` | `dev` | `dev` | A phase of the plan or a self contained feature |
| `chore/` | `dev` | `dev` | Tooling, CI, documentation infrastructure |
| `fix/` | `dev` | `dev` | A defect found on `dev` |
| `release/` | `dev` | `dev`, then `main` | Version bump, changelog, final checks |
| `hotfix/` | `main` | `dev`, then `main` | An urgent defect in a released version |

## Rules

1. Every merge into `dev` uses `--no-ff`, so each branch keeps a merge commit that names it.
2. Branches are kept after merge. Do not run `git branch -d` or delete branches on the remote.
3. `dev` must build and pass tests at every merge commit. Merges that break `dev` are fixed
   forward on a `fix/` branch, not reverted silently.
4. A commit message uses the imperative mood, a conventional commit type, and carries the
   project co-author trailers.
5. A release branch is cut from `dev` when the phase gates for a version are all green.
   It bumps versions and updates the changelog, merges back to `dev`, and only then is it
   offered to `main`.

## Phase branches

The development plan is split into gated phases. Each has its own branch, and none of them
are deleted, so the history of each phase stays inspectable.

| Branch | Phase | Gate status |
| --- | --- | --- |
| `feature/p0-feasibility-spikes` | P0 Feasibility spikes | Answered, finally: the gate FAILED for the reason in spikes/RESULTS.md, and spike 08 measured the route that replaced the design. |
| `chore/ci-pipeline` | Continuous integration foundation | Cleared |
| `feature/p1-arena` | P1 The arena | Cleared. The twenty four hour soak is a release gate and is recorded per release. |
| `feature/p2-object-layer` | P2 The object layer | Cleared. Bounded write allocation asserted by test. |
| `feature/p3-electron-integration` | P3 Electron integration | Superseded by the native transport; the window.open integration was deleted under ADR 0003. |
| `feature/p4-bindings-dx` | P4 Bindings and developer experience | Deliverables complete. The gate asks for an application built by someone else from the docs alone, which has not happened. |
| `feature/p5-hardening` | P5 Hardening | Fuzz clean, security note written and rewritten for the native transport. No outside reviewer has read it. |
| `release/0.1.0` | P6 Release | Deliverables complete; never published. |
| `feature/n0-land-the-gate-results` | N0 Land the measurements | Cleared |
| `feature/n1-shm-transport` | N1 The transport package | Cleared: six platform prebuilds, cross process soak, layout two after the soak broke layout one. |
| `feature/n2-native-electron`, `feature/n2-native-chaos`, `feature/n2-delete-window-open` | N2 The rewire | Cleared: nineteen e2e checks and window lifecycle chaos green on real processes; the old machinery deleted. |
| `feature/n3-native-matrix` | N3 Matrix, soak, benchmarks | Cleared: nineteen of nineteen matrix jobs green, Electron 31 to 33 across three platforms, plus the beta canary on the native route. |
| `feature/n4-doc-rewrites` | N4 The claim | Docs rewritten. The external review of the trust model remains open, and is a 1.0 gate rather than a 0.2.0 one. |
| `release/0.2.0` | The native transport release | Shipped 2026-08-29 as @bradensbay/globals 0.2.0, ahead of the twenty four hour soak by the owner's decision; the soak completes after the fact and its recording lands in soak-results. |

Gate status is tracked here rather than only in the plan, because a branch that merged is not
the same as a gate that passed, and conflating the two is how a project convinces itself it is
further along than it is.

## Commit message format

```
<type>(<scope>): <subject>

<body explaining why, not what>

Co-Authored-By: Christian Rogers <christiangrrogers@gmail.com>
Co-Authored-By: Claude <noreply@anthropic.com>
```

Types in use: `feat`, `fix`, `docs`, `test`, `perf`, `refactor`, `chore`, `ci`, `build`.
