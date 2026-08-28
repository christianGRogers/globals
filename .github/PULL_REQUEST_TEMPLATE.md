## What this changes

<!-- One paragraph. What is different after this merges. -->

## Why

<!-- The constraint or defect that forced the change. -->

## Target branch

- [ ] This pull request targets `dev`. Only a release merge targets `main`.

## Phase and gate

<!-- Which plan phase this belongs to, and which gate criterion it moves. -->

## Invariants

- [ ] The writer does not mutate a published node.
- [ ] Every new decode path validates its offset and fails closed.
- [ ] Nothing was added to the read path that performs IPC, allocates a promise, or awaits.
- [ ] The layout version was bumped if the arena layout changed.

## Verification

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run soak` (required for arena or reclamation changes, paste the summary)
- [ ] `npm run bench` (required for any performance claim, describe the machine)

## Documentation

- [ ] Public API changes are documented under `docs/`.
- [ ] `CHANGELOG.md` has an entry under Unreleased.
