import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OwnerRegion, ReaderRegion } from "../src/index.js";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "globals-shm-x-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// Compiled tests live in dist/test; the child helpers stay plain source next to the tests.
const helper = (name: string) =>
  fileURLToPath(new URL(`../../test/helpers/${name}`, import.meta.url));

const SIZE = 256 * 1024;
// The fast-suite torture runs on two-core CI runners where a large copy barely fits the
// writer's stable window. This size keeps the collision pressure real and the runtime
// bounded; the nightly soak is where the big regions get tortured.
const TORTURE_SIZE = 64 * 1024;

test("a commit flushed here is read intact by a child process", async () => {
  const path = join(dir, "parent-owns.mem");
  const owner = OwnerRegion.create(path, SIZE);
  const seed = 17;
  const src = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) src[i] = (i + seed) % 251;
  owner.flush(src);

  const { stdout } = await run(process.execPath, [helper("reader-child.mjs"), path, String(seed)], {
    timeout: 30_000,
  });
  const report = JSON.parse(stdout) as { pid: number; version: number };
  assert.notEqual(report.pid, process.pid, "the reader must be another OS process");
  assert.equal(report.version, 1);
  owner.close();
});

test("a child writer at full rate never shows this process a torn commit", async () => {
  const path = join(dir, "child-owns.mem");
  const durationMs = 1500;
  const writer = run(process.execPath, [helper("writer-child.mjs"), path, String(TORTURE_SIZE), String(durationMs)], {
    timeout: 30_000,
  });

  // The child creates the region; attach as soon as the file exists and holds a commit.
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  let reader: ReaderRegion | null = null;
  while (reader === null && Date.now() < deadline) {
    try {
      reader = ReaderRegion.attach(path);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(reader, "could not attach to the child's region in time");

  const dest = new Uint8Array(reader.dataSize);
  let reads = 0;
  let torn = 0;
  let lastVersion = 0;
  let regressions = 0;
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const version = reader.sync(dest);
    reads++;
    if (version < lastVersion) regressions++;
    lastVersion = version;
    const first = dest[0];
    for (let i = 1; i < dest.length; i++) {
      if (dest[i] !== first) {
        torn++;
        break;
      }
    }
  }
  reader.close();

  const { stdout } = await writer;
  const report = JSON.parse(stdout) as { pid: number; version: number };
  assert.notEqual(report.pid, process.pid, "the writer must be another OS process");
  assert.ok(reads > 100, `expected a busy reader, got ${reads} reads`);
  assert.ok(report.version > 100, `expected a busy writer, got ${report.version} commits`);
  assert.equal(torn, 0, `${torn} of ${reads} synced copies mixed two commits`);
  assert.equal(regressions, 0, "a synced version went backwards");
  assert.ok(lastVersion > 1, "the reader never observed the writer's progress");
});
