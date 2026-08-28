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
| `feature/p0-feasibility-spikes` | P0 Feasibility spikes | Partly cleared. Atomics and read latency measured and passing. Buffer sharing unproven: spike 01 could not run without a display. |
| `chore/ci-pipeline` | Continuous integration foundation | Cleared |
| `feature/p1-arena` | P1 The arena | Cleared on a five minute soak. The plan asks for twenty four hours, which is a release gate. |
| `feature/p2-object-layer` | P2 The object layer | Cleared. Bounded write allocation asserted by test. |
| `feature/p3-electron-integration` | P3 Electron integration | Half cleared. The runtime agnostic chaos harness passes. The Electron one has not run. |
| `feature/p4-bindings-dx` | P4 Bindings and developer experience | Deliverables complete. The gate asks for an application built by someone else from the docs alone, which has not happened. |
| `feature/p5-hardening` | P5 Hardening | Two of three. Clean fuzz run and a written security note. No outside reviewer has read it, and the matrix has only run on one machine. |
| `release/0.1.0` | P6 Release | Deliverables complete |

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
