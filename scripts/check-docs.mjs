#!/usr/bin/env node
/**
 * Documentation checks that run in CI.
 *
 * 1. No em dashes or en dashes in prose. House style uses commas, colons, or a
 *    restructured sentence.
 * 2. Every file the README and CONTRIBUTING link to inside the repository exists.
 * 3. Required top level documents are present.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "out", "build"]);
const REQUIRED = [
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "docs/contract.md",
  "docs/architecture.md",
  "docs/trust-model.md",
  "docs/branching.md",
  "docs/plan.md",
];

const problems = [];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

for (const required of REQUIRED) {
  if (!(await exists(join(root, required)))) {
    problems.push(`missing required document: ${required}`);
  }
}

const markdown = await walk(root);

for (const file of markdown) {
  const text = await readFile(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");

  text.split("\n").forEach((line, index) => {
    const dash = line.match(/[\u2014\u2013]/);
    if (dash) {
      problems.push(`${rel}:${index + 1} contains a long dash, rewrite the sentence`);
    }
  });

  for (const match of text.matchAll(/\]\(([^)#:]+?)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (!target || target.startsWith("http") || target.startsWith("mailto:")) continue;
    const resolved = resolve(dirname(file), target);
    if (!(await exists(resolved))) {
      problems.push(`${rel} links to a missing path: ${target}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`documentation check failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`documentation check passed over ${markdown.length} markdown file(s)`);
