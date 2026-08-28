/**
 * The decoder fuzzer.
 *
 * Build a realistic arena, corrupt it at random, and decode it. The requirement is not that
 * a decode succeeds. It is that every failure is a typed error from this library, never a
 * TypeError from dereferencing something, never a RangeError from an enormous allocation,
 * never a hang, and never a plausible looking value produced from bytes a correct writer
 * could not have written.
 *
 * This is a hardening tool rather than a regression test, because any window that maps the
 * arena can produce exactly these states. A corrupt arena is a reachable condition, not a
 * hypothetical.
 *
 *   node packages/core/dist/test/fuzz/run-fuzz.js --iterations 20000
 */
import { openSync, writeSync, ftruncateSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ArenaOwner } from "../../src/owner.js";
import { ArenaReader } from "../../src/reader.js";
import { SharedArena } from "../../src/arena.js";
import { GlobalsError } from "../../src/errors.js";
import { Header, VerifyMode, WORD } from "../../src/layout.js";
import { decodeValue } from "../../src/values.js";
import { Tag } from "../../src/tags.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    iterations: { type: "string", default: "20000" },
    seed: { type: "string", default: "20260827" },
    report: { type: "string" },
    "timeout-ms": { type: "string", default: "2000" },
    trace: { type: "string" },
    inspect: { type: "string" },
    dump: { type: "string" },
  },
});

const iterations = Number(values.iterations);
const timeoutMs = Number(values["timeout-ms"]);
let seed = Number(values.seed) | 0;

function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return (seed >>> 0) / 2 ** 32;
}

function randomInt(bound: number): number {
  return Math.floor(random() * bound);
}

/** A shape with every branch of the decoder in it. */
function sampleState(): unknown {
  return {
    title: "a string of some length",
    count: 42,
    ratio: 1.5,
    flag: true,
    nothing: null,
    when: new Date("2026-08-27T00:00:00.000Z"),
    pattern: /ab+c/gi,
    big: 123456789012345678901234567890n,
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    floats: new Float64Array([1.5, 2.5]),
    rows: Array.from({ length: 120 }, (_unused, id) => ({
      id,
      name: `row ${id}`,
      tags: [`tag-${id % 5}`],
      nested: { deep: { deeper: id * 1.5 } },
    })),
    lookup: new Map<string | number, unknown>([
      ["a", 1],
      [2, "b"],
    ]),
    members: new Set([1, "two", true]),
  };
}

interface Outcome {
  decoded: number;
  typedErrors: number;
  untypedErrors: number;
  timeouts: number;
  examples: { kind: string; message: string }[];
}

const outcome: Outcome = {
  decoded: 0,
  typedErrors: 0,
  untypedErrors: 0,
  timeouts: 0,
  examples: [],
};

const errorKinds = new Map<string, number>();

function record(error: unknown): void {
  if (error instanceof GlobalsError) {
    outcome.typedErrors += 1;
    const kind = error.name;
    errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
    return;
  }
  outcome.untypedErrors += 1;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (outcome.examples.length < 20) {
    outcome.examples.push({ kind: "untyped", message });
  }
}

/**
 * One clean arena, captured once as a template.
 *
 * Each round restores the template into a single reusable buffer and corrupts that. Building
 * a fresh owner per round was the obvious way to write this and it was wrong: every round
 * allocated another SharedArrayBuffer, and eight thousand of them exhausted the heap before
 * the decoders had a chance to fail. The fuzzer was crashing on its own bookkeeping and
 * reporting it as a library failure, which is worse than not running at all.
 *
 * The template is a real arena a real writer produced, so a corrupted copy still resembles
 * what a hostile window would leave behind.
 */
const template = (() => {
  const owner = ArenaOwner.create({
    byteLength: 1 << 18,
    maxByteLength: 1 << 18,
    maxReaders: 4,
    retainedVersions: 8,
    // Off, because the point is to exercise the decoders. With verification on the checksum
    // would reject most of these before a decoder ran, which is the right production
    // behaviour and the wrong thing to measure here.
    verify: VerifyMode.Off,
  });
  owner.commit(sampleState());
  return new Uint8Array(new Uint8Array(owner.buffer).slice());
})();

const scratch = new SharedArrayBuffer(template.byteLength);
const scratchBytes = new Uint8Array(scratch);

let inspecting = false;

function note(label: string): void {
  if (!inspecting) return;
  const heap = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
  console.log(`      [inspect] ${label}, heap ${heap} MB`);
}

function round(): void {
  scratchBytes.set(template);

  const arena = SharedArena.attach(scratch);
  const words = arena.words;
  const arenaStart = arena.geometry.arenaOffset / WORD;

  // Between one and eight mutations, weighted towards the small end, because a single
  // stray write is the realistic case and a thousand of them is just noise.
  const mutations = 1 + randomInt(randomInt(8) + 1);
  for (let i = 0; i < mutations; i += 1) {
    const style = randomInt(5);
    const index = arenaStart + randomInt(words.length - arenaStart);

    if (style === 0) words[index] = randomInt(2 ** 31) | 0;
    else if (style === 1) words[index] = 0;
    else if (style === 2) words[index] = -1;
    else if (style === 3) words[index] = (words[index] as number) ^ (1 << randomInt(32));
    else words[index] = arena.byteLength + randomInt(1 << 20);
  }

  // Sometimes corrupt the root slot itself, which is the highest leverage single write a
  // hostile window has.
  if (randomInt(4) === 0) {
    arena.storeHeader(Header.RootTag, randomInt(20));
  }
  if (randomInt(4) === 0) {
    arena.storeHeader(Header.RootPayload, randomInt(arena.byteLength));
  }

  note(`root tag ${arena.loadHeader(Header.RootTag)} payload ${arena.loadHeader(Header.RootPayload)}`);
  if (inspecting && values.dump !== undefined) {
    writeFileSync(String(values.dump), Buffer.from(scratchBytes.slice()));
    console.log(`      [inspect] dumped ${scratchBytes.length} bytes`);
  }

  let reader: ArenaReader;
  try {
    reader = ArenaReader.attach(scratch);
  } catch (error) {
    // A mutation landed on the configuration header, so attaching is refused. That is the
    // check working rather than a decode failure.
    record(error);
    return;
  }
  const started = Date.now();

  try {
    note("acquiring");
    const snapshot = reader.acquire();
    note("acquired, decoding");
    snapshot.toJSON();
    note("decoded");
    outcome.decoded += 1;
  } catch (error) {
    note(`threw ${error instanceof Error ? error.name : "unknown"}`);
    record(error);
  }

  if (Date.now() - started > timeoutMs) {
    outcome.timeouts += 1;
  }

  // Also decode a few arbitrary slots directly, which reaches paths a corrupted root would
  // have short circuited.
  for (let i = 0; i < 4; i += 1) {
    const tag = randomInt(16);
    const payload = randomInt(arena.byteLength + 4096) - 2048;
    try {
      note(`direct decode tag ${tag} payload ${payload}`);
      decodeValue(arena, { tag, payload });
      outcome.decoded += 1;
    } catch (error) {
      record(error);
    }
  }

  // And one deliberately targeted at a real block, with the tag lying about what it is.
  try {
    const payload = arena.loadHeader(Header.RootPayload);
    decodeValue(arena, { tag: Tag.String, payload });
    outcome.decoded += 1;
  } catch (error) {
    record(error);
  }

  reader.detach();
}

// A crash from running out of memory cannot be caught, so the round index is written
// synchronously before each round. After a crash the file names the case that caused it,
// which is the difference between diagnosing this and guessing at it.
const traceFd = values.trace === undefined ? undefined : openSync(String(values.trace), "w");

const startedAt = Date.now();
let nextProgressAt = Date.now() + 15_000;
for (let i = 0; i < iterations; i += 1) {
  inspecting = values.inspect !== undefined && Number(values.inspect) === i;
  if (traceFd !== undefined) {
    ftruncateSync(traceFd, 0);
    writeSync(traceFd, `round ${i}
`, 0);
  }
  round();
  if (Date.now() >= nextProgressAt) {
    nextProgressAt = Date.now() + 15_000;
    const heap = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    console.log(`  ... ${i} of ${iterations}, heap ${heap} MB`);
  }
}
const elapsed = (Date.now() - startedAt) / 1000;

const summary = {
  iterations,
  seed: Number(values.seed),
  elapsedSeconds: elapsed,
  ...outcome,
  errorKinds: Object.fromEntries(errorKinds),
};

console.log("fuzz summary\n");
console.log(`  iterations        ${iterations} in ${elapsed.toFixed(1)}s`);
console.log(`  decoded           ${outcome.decoded}`);
console.log(`  typed errors      ${outcome.typedErrors}`);
console.log(`  untyped errors    ${outcome.untypedErrors}`);
console.log(`  slow decodes      ${outcome.timeouts}`);
console.log("");
for (const [kind, count] of [...errorKinds].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${kind.padEnd(24)} ${count}`);
}

if (outcome.examples.length > 0) {
  console.log("\n  untyped failures, which are the ones that matter:");
  for (const example of outcome.examples) console.log(`    ${example.message}`);
}

if (values.report) {
  await mkdir(dirname(values.report), { recursive: true });
  await writeFile(values.report, JSON.stringify(summary, null, 2));
  console.log(`\n  report written to ${values.report}`);
}

const failures: string[] = [];
if (outcome.untypedErrors > 0) {
  failures.push(`${outcome.untypedErrors} failures were not typed errors from this library`);
}
if (outcome.timeouts > 0) failures.push(`${outcome.timeouts} decodes took longer than ${timeoutMs} ms`);
if (outcome.typedErrors === 0) {
  failures.push("no corruption was detected at all, so the fuzzer is not corrupting anything");
}

if (failures.length > 0) {
  console.error(`\ngate: FAIL, ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\ngate: PASS, every decode either succeeded or failed closed with a typed error");
process.exit(0);
