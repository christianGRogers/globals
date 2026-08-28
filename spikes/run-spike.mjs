#!/usr/bin/env node
/**
 * Phase 0 spike runner.
 *
 * Spikes are throwaway diagnostics, not tests. They print a measurement and a gate
 * verdict, and they exit nonzero when a gate fails.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  "04": {
    name: "read latency",
    runtime: "node",
    entry: "04-read-latency/index.mjs",
    gate: "shared read at least 50 times faster than an IPC round trip",
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

function runElectron(spike, rest) {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["electron", join(here, spike.entry), ...rest],
      { stdio: "inherit", cwd: join(here, "..") },
    );
    child.on("error", (error) => {
      console.error(`could not start Electron: ${error.message}`);
      console.error("install it first: npm install --no-save electron@^33");
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 1));
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
