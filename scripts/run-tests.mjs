#!/usr/bin/env node
/**
 * Run the compiled unit and property tests.
 *
 * The Node test runner treats every file inside a directory named `test` as a test file,
 * which would sweep up the soak entry point and run a two minute soak on every `npm test`.
 * Discovering `*.test.js` explicitly keeps the fast suite fast and leaves the soak to
 * `npm run soak`, where its duration is a deliberate choice.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "src", "coverage"]);

async function findTests(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTests(full)));
    else if (entry.name.endsWith(".test.js")) found.push(full);
  }
  return found;
}

const packages = await readdir(join(root, "packages"), { withFileTypes: true });
const files = [];
for (const entry of packages) {
  if (!entry.isDirectory()) continue;
  files.push(...(await findTests(join(root, "packages", entry.name, "dist", "test"))));
}

if (files.length === 0) {
  console.error("no compiled test files were found. Run npm run build first.");
  process.exit(1);
}

console.log(`running ${files.length} test file(s)`);
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 1));
