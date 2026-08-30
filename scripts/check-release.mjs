#!/usr/bin/env node
/**
 * Check that a release is internally consistent, before a tag discovers it is not.
 *
 * Two tags have now died in the release workflow on a condition that was knowable from a
 * checkout: one because verify tested without building the addon, one because the version
 * was never bumped and `v0.2.1` met a tree that still said `0.2.0`. Both cost a full run to
 * learn. This runs in a second.
 *
 * Three things are checked, and the second is the one a hand edit gets wrong. Bumping the
 * six `version` fields is the obvious half of a release; the five internal dependency pins
 * are exact, and a release that misses them publishes happily and then resolves
 * `@bradensbay/globals@0.2.1` against `globals-core@0.2.0`, which is a broken install that
 * npm has no reason to refuse.
 *
 *   node scripts/check-release.mjs            # internal consistency only
 *   node scripts/check-release.mjs v0.2.1     # and that the tag agrees
 *
 * With no argument it falls back to GITHUB_REF_NAME, so the release workflow needs to pass
 * nothing. Without either, the tag check is skipped and the rest still runs, which is what
 * makes this safe to call from `npm run verify` on an ordinary commit.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Every workspace package, resolved from the root manifest rather than hardcoded. */
async function workspacePackages() {
  const rootManifest = await readJson(join(root, "package.json"));
  const found = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      problems.push(`unsupported workspace pattern "${pattern}", this check expects "dir/*"`);
      continue;
    }
    const dir = join(root, pattern.slice(0, -2));
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dir, entry.name, "package.json");
      try {
        found.push({ path: `${pattern.slice(0, -2)}/${entry.name}`, manifest: await readJson(manifestPath) });
      } catch {
        // A directory without a manifest is not a workspace member.
      }
    }
  }
  return found;
}

const packages = await workspacePackages();
if (packages.length === 0) {
  console.error("no workspace packages were found, so there is nothing to check");
  process.exit(1);
}

const published = packages.filter((entry) => entry.manifest.private !== true);
const names = new Set(published.map((entry) => entry.manifest.name));

// 1. One version across the workspace. These packages are released together and their
//    interdependencies are exact, so a split version is never intentional here.
const versions = new Set(published.map((entry) => entry.manifest.version));
if (versions.size > 1) {
  problems.push(`the workspace carries ${versions.size} different versions: ${[...versions].sort().join(", ")}`);
  for (const entry of published) {
    problems.push(`  ${entry.path} is ${entry.manifest.version}`);
  }
}
const [version] = versions;

// 2. Every internal pin names that same version. This is the half a hand edit misses.
for (const entry of published) {
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [dependency, range] of Object.entries(entry.manifest[field] ?? {})) {
      if (!names.has(dependency)) continue;
      if (range !== version) {
        problems.push(
          `${entry.path} pins ${dependency} at "${range}" in ${field}, but the workspace is at ${version}`,
        );
      }
    }
  }
}

// 3. The tag, when there is one, agrees with the tree it points at.
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag !== undefined && tag !== "" && tag.startsWith("v")) {
  if (tag !== `v${version}`) {
    problems.push(
      `tag ${tag} does not match the workspace version v${version}. ` +
        `A release branch bumps the version and the changelog before the tag is pushed; see docs/branching.md.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`release check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const scope = tag ? `for ${tag}` : "for an untagged tree";
console.log(
  `release check passed ${scope}: ${published.length} package(s) at ${version}, every internal pin agrees`,
);
