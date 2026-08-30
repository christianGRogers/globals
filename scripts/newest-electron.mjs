#!/usr/bin/env node
/**
 * Print the newest Electron version npm offers, prereleases included.
 *
 * The canary job exists to run ahead of the matrix, and `electron@beta` does not guarantee
 * that. For the weeks between a major going stable and the next major's betas opening, the
 * beta tag still points at a prerelease of the version that already shipped: on the day this
 * was written, `latest` was 44.0.0 and `beta` was 44.0.0-beta.6. A canary pinned to that tag
 * spends part of every release cycle testing something older than the matrix does, which is
 * the one thing a canary must never do quietly.
 *
 * Considering alpha, beta, and latest together and taking the highest keeps it ahead
 * whichever phase of the cycle the run lands in.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const run = promisify(execFile);

/**
 * Compare two semantic versions. Enough of the specification for dist tags: numeric
 * identifiers compare numerically, a prerelease sorts below the release it prefixes, and
 * prerelease identifiers compare field by field.
 */
export function compareVersions(a, b) {
  const split = (version) => {
    const [core, prerelease] = version.split("-", 2);
    return {
      core: core.split(".").map(Number),
      prerelease: prerelease === undefined ? null : prerelease.split("."),
    };
  };
  const left = split(a);
  const right = split(b);

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  // A release outranks any prerelease of the same core version.
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === null ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) > Number(y) ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// Importable for the unit test without shelling out to npm; run as an entry point it prints.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { stdout } = await run("npm", ["view", "electron", "dist-tags", "--json"], {
    shell: process.platform === "win32",
  });
  const tags = JSON.parse(stdout);
  const candidates = [tags.alpha, tags.beta, tags.latest].filter(
    (value) => typeof value === "string",
  );
  if (candidates.length === 0) {
    console.error("npm returned no alpha, beta, or latest tag for electron");
    process.exit(1);
  }
  candidates.sort(compareVersions);
  console.log(candidates[candidates.length - 1]);
}
