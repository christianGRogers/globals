#!/usr/bin/env node
/**
 * The cross process transport soak: one writer process flushing at full rate, N reader
 * processes syncing and validating for the duration, everything in separate OS processes,
 * which is the boundary the fast suite can only touch briefly. This is the release gate for
 * changes to the region protocol, the same way the arena soak gates the arena.
 *
 *   node packages/shm/test/soak/run-soak.mjs --readers 4 --seconds 3600
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    readers: { type: "string", default: "4" },
    seconds: { type: "string", default: "60" },
    size: { type: "string", default: String(1 << 20) },
    report: { type: "string", default: "" },
  },
});
const readers = Number(values.readers);
const seconds = Number(values.seconds);
const size = Number(values.size);
const regionPath = join(tmpdir(), `globals-shm-soak-${process.pid}.mem`);

const children = [];
function child(script, args) {
  const proc = spawn(process.execPath, [join(here, script), ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(proc);
  return proc;
}

const startedAt = Date.now();
console.log(`transport soak: ${readers} readers, ${seconds}s, ${size} byte region`);

const writer = child("../helpers/writer-child.mjs", [regionPath, String(size), String(seconds * 1000)]);
// Attached at spawn time: a listener added after the process already exited never fires,
// and an unsettled top-level await is a silent exit with no verdict at all.
const writerExit = new Promise((resolve) => writer.on("exit", resolve));
let writerFinal;
createInterface({ input: writer.stdout }).on("line", (line) => {
  try {
    writerFinal = JSON.parse(line);
  } catch {
    /* not a report line */
  }
});

const latest = new Map();
const readerExits = [];
for (let id = 0; id < readers; id++) {
  const proc = child("reader-child.mjs", [regionPath, String(seconds * 1000), String(id)]);
  createInterface({ input: proc.stdout }).on("line", (line) => {
    try {
      const report = JSON.parse(line);
      latest.set(report.id, report);
      if (!report.final) {
        console.log(
          `  reader ${report.id}: ${report.reads} reads, ${report.violations} violations, at version ${report.lastVersion}`,
        );
      }
    } catch {
      /* not a report line */
    }
  });
  readerExits.push(new Promise((resolve) => proc.on("exit", resolve)));
}

const exitCodes = await Promise.all(readerExits);
await writerExit;
await unlink(regionPath).catch(() => {});

const finals = [...latest.values()];
const totals = finals.reduce(
  (sum, r) => ({
    reads: sum.reads + r.reads,
    violations: sum.violations + r.violations,
    regressions: sum.regressions + r.regressions,
  }),
  { reads: 0, violations: 0, regressions: 0 },
);
const writerVersion = writerFinal?.version ?? 0;

const checks = [
  { name: "every reader exited cleanly", pass: exitCodes.every((code) => code === 0) },
  { name: "every reader reported", pass: finals.length === readers && finals.every((r) => r.final) },
  {
    name: "zero torn copies",
    pass: totals.violations === 0 && totals.reads > readers * seconds,
    detail: `${totals.violations} violations in ${totals.reads} reads`,
  },
  { name: "zero version regressions", pass: totals.regressions === 0 },
  {
    name: "every reader kept up with the writer",
    pass: writerVersion > 0 && finals.every((r) => r.lastVersion > writerVersion * 0.5),
    detail: `writer reached ${writerVersion}, readers ended at ${finals.map((r) => r.lastVersion).join(", ")}`,
  },
];

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `, ${check.detail}` : ""}`);
}
const verdict = checks.every((c) => c.pass) ? "PASS" : "FAIL";
console.log(`\nverdict: ${verdict} after ${Math.round((Date.now() - startedAt) / 1000)}s`);

if (values.report !== "") {
  await mkdir(dirname(String(values.report)), { recursive: true });
  await writeFile(
    String(values.report),
    JSON.stringify(
      { platform: process.platform, arch: process.arch, at: new Date().toISOString(), seconds, readers, size, writerVersion, finals, checks, verdict },
      null,
      2,
    ),
  );
}
process.exit(verdict === "PASS" ? 0 : 1);
