#!/usr/bin/env node
/**
 * Launch an Electron entry point and report its verdict.
 *
 * Two things this handles that `npx electron` does not.
 *
 * On Windows, spawning the `npx.cmd` shim without a shell fails with EINVAL on current Node,
 * and going through a shell to work around it loses the exit code that a gate depends on.
 * The binary is resolved through the `electron` module instead.
 *
 * An Electron main process on Windows is a GUI subsystem binary, so its console output never
 * reaches the parent pipe. Anything that needs to report a verdict writes it to a JSON file,
 * and this prints that file after the process exits.
 *
 *   node scripts/run-electron.mjs <entry> [--report <path>] [...args]
 *
 * Exported as functions as well as a command, because the spike runner needs the same
 * behaviour and a second copy of it is a second place for the spawn problem to come back.
 */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Electron binary path, or undefined when it is not installed. */
export async function electronBinary() {
  try {
    const binary = (await import("electron")).default;
    return typeof binary === "string" ? binary : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Launch an entry point and return a process exit code.
 *
 * Zero for a pass, one for a failure or a run that produced no verdict, 127 when Electron is
 * not installed.
 */
export async function launch({ entry, reportPath, args = [], quiet = false }) {
  const binary = await electronBinary();
  if (binary === undefined) {
    console.error("Electron is not installed. From the repository root:");
    console.error("  npm install");
    return 127;
  }

  const target = reportPath === undefined ? undefined : resolve(reportPath);
  if (target !== undefined) await rm(target, { force: true });

  if (!quiet) {
    console.log(`launching ${entry}`);
    console.log("a window will open. Leave it alone until it closes on its own.\n");
  }

  const code = await new Promise((settle) => {
    const child = spawn(binary, [entry, ...args], { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`could not start Electron: ${error.message}`);
      settle(127);
    });
    child.on("exit", (exitCode) => settle(exitCode ?? 1));
  });

  if (target === undefined) return code;

  let report;
  try {
    report = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // Worth distinguishing loudly. A gate failure is an answer. A run that never decided is
    // not, and treating the second as the first is how a project talks itself into an off
    // ramp it did not need.
    console.error(
      "\nno report was written, so the run crashed before it could decide anything.\n" +
        "That is not a gate failure, it is a broken run. Check the Electron version and try again.",
    );
    return code === 0 ? 1 : code;
  }

  printReport(entry, report, target);
  return report.verdict === "PASS" ? 0 : 1;
}

/** Print a verdict report in the shape the spikes and the chaos app write. */
export function printReport(entry, report, reportPath) {
  console.log(
    `\n${entry} on Electron ${report.electron}, Chromium ${report.chromium}, ` +
      `${report.platform} ${report.arch}\n`,
  );

  for (const window of report.reports ?? []) {
    console.log(`  ${String(window.window ?? window.id).padEnd(8)} ${JSON.stringify(window)}`);
  }
  // The chaos app writes observations as an array, the e2e apps as an object by window.
  const observations = report.observations ?? [];
  for (const observation of Array.isArray(observations) ? observations : Object.values(observations)) {
    console.log(`  ${JSON.stringify(observation)}`);
  }
  if (report.events) console.log(`  events: ${JSON.stringify(report.events)}`);
  for (const line of report.rendererLog ?? []) console.log(`  ${line}`);

  console.log("");
  for (const check of report.checks ?? []) {
    const detail = check.detail ? `, ${check.detail}` : "";
    console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}${detail}`);
  }
  for (const failure of report.failures ?? []) {
    console.log(`FAIL  ${failure}`);
  }

  console.log(`\nverdict: ${report.verdict}`);
  if (reportPath !== undefined) console.log(`report:  ${reportPath}`);
}

// The command line form, when this file is run directly rather than imported.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const entry = args[0];

  if (entry === undefined || entry === "--help") {
    console.log("usage: node scripts/run-electron.mjs <entry> [--report <path>] [...args]");
    process.exit(entry === undefined ? 2 : 0);
  }

  const reportFlag = args.indexOf("--report");
  process.exit(
    await launch({
      entry,
      reportPath: reportFlag === -1 ? undefined : args[reportFlag + 1],
      args: args.slice(1),
    }),
  );
}
