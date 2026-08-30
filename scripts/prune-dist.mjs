#!/usr/bin/env node
/**
 * Delete build output whose source no longer exists.
 *
 * `tsc --build` is incremental and never prunes: when a source file is deleted or renamed,
 * whatever it emitted stays in `dist` indefinitely. Two things then go wrong, and both are
 * quiet.
 *
 * The first is the test suite. `run-tests.mjs` discovers `*.test.js` under `dist/test`, so an
 * orphaned compiled test keeps running. If it fails, the failure is confusing. If it passes,
 * it is reporting green for a module that no longer exists, which is worse. Continuous
 * integration never sees either, because it builds from a clean checkout, so the suite is
 * least trustworthy exactly where it runs most often.
 *
 * The second is publishing. Every package ships `dist/src`, so a release built on a working
 * tree with stale output publishes modules that were deleted, complete with imports of
 * packages that no longer exist under those names.
 *
 * Pruning rather than wiping keeps the incremental build, which is the whole reason
 * `tsc --build` is used here: `npm test` builds first, and a full rebuild on every test run
 * is a cost paid many times a day for a problem that occurs at a rename.
 */
import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Emit suffixes, longest first, so `.d.ts.map` is not mistaken for `.map` or `.ts`. */
const EMIT_SUFFIXES = [".d.ts.map", ".d.ts", ".js.map", ".js"];
/** Extensions tsc will compile from. A stem matching any of these is not an orphan. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
/** Build state, not emitted output. Deleting it would silently force a full rebuild. */
const KEEP = new Set(["tsconfig.tsbuildinfo"]);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** tsconfig files here are plain JSON, but tolerate the line comments the format allows. */
async function readTsconfig(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

/** The projects `tsc --build` builds, read from the solution rather than hardcoded. */
async function projects() {
  const solution = await readTsconfig(join(root, "tsconfig.build.json"));
  const out = [];
  for (const reference of solution.references ?? []) {
    const dir = resolve(root, reference.path);
    const config = await readTsconfig(join(dir, "tsconfig.json"));
    out.push({
      dir,
      rootDir: resolve(dir, config.compilerOptions?.rootDir ?? "."),
      outDir: resolve(dir, config.compilerOptions?.outDir ?? "dist"),
    });
  }
  return out;
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/**
 * The source file an emitted file came from, or null when the name is not an emit at all.
 * Resolution mirrors tsc: the path below `outDir` is the path below `rootDir`.
 */
async function sourceFor(project, emitted) {
  const name = relative(project.outDir, emitted);
  const suffix = EMIT_SUFFIXES.find((candidate) => name.endsWith(candidate));
  if (suffix === undefined) return { orphan: false, source: null };
  const stem = join(project.rootDir, name.slice(0, -suffix.length));
  for (const extension of SOURCE_EXTENSIONS) {
    if (await exists(stem + extension)) return { orphan: false, source: stem + extension };
  }
  return { orphan: true, source: null };
}

/** Remove directories left empty by pruning, deepest first. */
async function removeEmptyDirectories(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(join(dir, entry.name));
  }
  if ((await readdir(dir)).length === 0) await rmdir(dir);
}

const checkOnly = process.argv.includes("--check");
const pruned = [];

for (const project of await projects()) {
  for (const emitted of await walk(project.outDir)) {
    if (KEEP.has(relative(project.outDir, emitted))) continue;
    const { orphan } = await sourceFor(project, emitted);
    if (!orphan) continue;
    pruned.push(relative(root, emitted).replaceAll("\\", "/"));
    if (!checkOnly) await rm(emitted);
  }
  if (!checkOnly) await removeEmptyDirectories(project.outDir);
}

if (pruned.length === 0) {
  if (!checkOnly) console.log("build output is in step with the sources");
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `${pruned.length} build output file(s) have no source. Run: node scripts/prune-dist.mjs`,
  );
  for (const path of pruned) console.error(`  ${path}`);
  process.exit(1);
}

console.log(`pruned ${pruned.length} orphaned build output file(s):`);
for (const path of pruned) console.log(`  ${path}`);
