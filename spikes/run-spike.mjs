#!/usr/bin/env node
/**
 * Phase 0 spike runner.
 *
 * Spikes are throwaway diagnostics, not tests. They print a measurement and a gate
 * verdict, and they exit nonzero when a gate fails.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { launch } from "../scripts/run-electron.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const SPIKES = {
  "01": {
    name: "share a buffer across sandboxed renderers",
    runtime: "electron",
    entry: "01-share-buffer/main.mjs",
    gate: "one SharedArrayBuffer reaches two sandboxed renderers with crossOriginIsolated true",
  },
  "02": {
    name: "atomics torture",
    runtime: "node",
    entry: "02-atomics-torture/index.mjs",
    gate: "zero ordering violations and zero lost updates",
  },
  "03": {
    name: "memory cage, addon route",
    runtime: "toolchain",
    entry: "03-memory-cage/README.md",
    gate: "napi_create_external_arraybuffer copies rather than shares",
  },
  "05": {
    name: "share a buffer through window.open",
    runtime: "electron",
    entry: "05-window-open/main.mjs",
    gate: "a SharedArrayBuffer survives a post to a window opened by the owner",
  },
  "06": {
    name: "share a buffer through a BroadcastChannel",
    runtime: "electron",
    entry: "06-broadcast-channel/main.mjs",
    gate: "a SharedArrayBuffer survives a broadcast to same origin contexts",
  },
  "07": {
    name: "let a SharedWorker own the buffer",
    runtime: "electron",
    entry: "07-shared-worker/main.mjs",
    gate: "a SharedWorker can hand its buffer to every window that connects",
  },
  "04": {
    name: "read latency",
    runtime: "node",
    entry: "04-read-latency/index.mjs",
    gate: "shared read at least 50 times faster than an IPC round trip",
  },
  "08": {
    name: "mmap through a native accessor, sandbox off",
    runtime: "electron",
    entry: "08-mmap-accessor/main.mjs",
    gate: "one mapped region visible across renderer processes, read at least 50 times faster than IPC",
  },
};

function list() {
  console.log("Phase 0 spikes\n");
  for (const [id, spike] of Object.entries(SPIKES)) {
    console.log(`  ${id}  ${spike.name}`);
    console.log(`      runtime: ${spike.runtime}`);
    console.log(`      gate:    ${spike.gate}\n`);
  }
}

async function runNode(spike, rest) {
  const module = await import(new URL(spike.entry, `file://${here}/`).href);
  return module.run(rest);
}

async function runElectron(spike, rest) {
  // Delegates to the shared launcher. Resolving the binary and printing a verdict file are
  // the same problem here as anywhere else, and keeping a second copy of the answer is how
  // the Windows spawn bug would come back.
  const reportPath = join(here, spike.entry.split("/")[0], `spike${command}-result.json`);
  return launch({
    entry: join(here, spike.entry),
    reportPath,
    args: [`--report=${reportPath}`, ...rest],
  });
}

const [command, ...rest] = process.argv.slice(2);
const args = rest[0] === "--" ? rest.slice(1) : rest;

if (!command || command === "list" || command === "--help") {
  list();
  process.exit(0);
}

const spike = SPIKES[command];
if (!spike) {
  console.error(`unknown spike: ${command}`);
  list();
  process.exit(2);
}

if (spike.runtime === "toolchain") {
  console.log(`Spike ${command} is not automated. Read ${spike.entry} and follow it.`);
  process.exit(0);
}

const code = spike.runtime === "electron"
  ? await runElectron(spike, args)
  : await runNode(spike, args);

process.exit(code);
