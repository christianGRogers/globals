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

The development plan is split into gated phases. Each has its own feature branch.

| Branch | Phase | Gate |
| --- | --- | --- |
| `feature/p0-feasibility-spikes` | P0 Feasibility spikes | Buffer crosses processes, atomics hold, reads beat IPC by 50x |
| `chore/ci-pipeline` | Continuous integration foundation | Build, test, and docs checks run on every push |
| `feature/p1-arena` | P1 The arena | Soak run with eight readers and zero inconsistent reads |
| `feature/p2-object-layer` | P2 The object layer | Realistic state round trips, bounded write allocation |
| `feature/p3-electron-integration` | P3 Electron integration | Chaos test leaves no leak, no stuck epoch, no bad read |
| `feature/p4-bindings-dx` | P4 Bindings and developer experience | Example app built from published docs alone |
| `feature/p5-hardening` | P5 Hardening | Green matrix, clean fuzz run, honest security note |
| `release/0.1.0` | P6 Release | Package split, docs, migration notes, stability statement |

## Commit message format

```
<type>(<scope>): <subject>

<body explaining why, not what>

Co-Authored-By: Christian Rogers <christiangrrogers@gmail.com>
Co-Authored-By: Claude <noreply@anthropic.com>
```

Types in use: `feat`, `fix`, `docs`, `test`, `perf`, `refactor`, `chore`, `ci`, `build`.
