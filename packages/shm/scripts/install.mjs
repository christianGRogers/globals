#!/usr/bin/env node
/**
 * Put the addon on disk at install time, by prebuild where one fits and by compiling where
 * none does.
 *
 * The development plan's risk register mitigated install friction with "prebuilds for all
 * six platform-arch pairs, compile fallback, install tested in CI". Only the first of those
 * existed. A platform outside the six installed successfully and then threw at the first
 * require, telling the user to run `npm run build:native`, a script that is not in the
 * published package. Alpine had it worse: the prebuild key carried no libc, so a musl
 * runtime resolved the glibc binary and failed at the dynamic linker, which reads like a
 * corrupt package rather than an unsupported one.
 *
 * The rules here:
 *
 * A matching prebuild means there is nothing to do, which is the case for almost everyone
 * and has to stay silent and instant.
 *
 * No matching prebuild means compiling, through the node-gyp npm hands to lifecycle
 * scripts. That needs a toolchain, and if there is not one, this says so in terms of what
 * to install rather than what failed.
 *
 * A failure to compile is not fatal to the install. That looks backwards for a package
 * whose entire content is a native addon, and it is deliberate: `npm install` runs in
 * places that never load this code, continuous integration images and Docker build layers
 * among them, and taking those down is worse than a clear error at the point of use. The
 * loader's message carries the same toolchain guidance, so the information is not lost.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * True when this is the repository's own copy rather than an installed dependency.
 *
 * Installing the workspace runs this for the member package too, and compiling there would
 * be wrong twice over: `npm run build:native` is the documented development path and every
 * workflow calls it explicitly, so a build here is duplicated work, and jobs that only need
 * the manifests would start needing a toolchain.
 */
function inDevelopmentWorkspace() {
  try {
    const parent = resolve(packageRoot, "..", "..", "package.json");
    if (!existsSync(parent)) return false;
    const manifest = JSON.parse(readFileSync(parent, "utf8"));
    return Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0;
  } catch {
    return false;
  }
}

if (inDevelopmentWorkspace()) {
  process.exit(0);
}

/** Mirrors libcSuffix in src/index.ts. Duplicated because this runs before any build. */
function libcSuffix() {
  if (process.platform !== "linux") return "";
  try {
    return process.report?.getReport()?.header?.glibcVersionRuntime === undefined ? "-musl" : "";
  } catch {
    return "";
  }
}

const target = `${process.platform}-${process.arch}${libcSuffix()}`;
const prebuild = join(packageRoot, "native", "prebuilds", target, "globals_shm.node");
const built = join(packageRoot, "native", "build", "Release", "globals_shm.node");

if (existsSync(prebuild) || existsSync(built)) {
  process.exit(0);
}

console.log(`@bradensbay/globals-shm: no prebuild for ${target}, building from source`);

// npm points lifecycle scripts at the node-gyp it ships, which is the one to prefer: this
// package declares no dependencies and should not grow one for a path most installs skip.
const nodeGyp = process.env["npm_config_node_gyp"];
const attempt = nodeGyp
  ? { command: process.execPath, args: [nodeGyp, "rebuild"] }
  : { command: process.platform === "win32" ? "node-gyp.cmd" : "node-gyp", args: ["rebuild"] };

const result = spawnSync(attempt.command, attempt.args, {
  cwd: join(packageRoot, "native"),
  stdio: "inherit",
  shell: false,
});

if (result.status === 0 && existsSync(built)) {
  console.log("@bradensbay/globals-shm: built");
  process.exit(0);
}

const toolchain =
  process.platform === "win32"
    ? "Visual Studio Build Tools with the C++ workload, and Python 3"
    : process.platform === "darwin"
      ? "the Xcode command line tools (xcode-select --install), and Python 3"
      : "a C compiler and Python 3 (build-essential on Debian and Ubuntu, base-devel on Alpine)";

console.warn(
  `\n@bradensbay/globals-shm: could not build the native addon for ${target}.\n` +
    `Install is not failing, because many installs never load it, but anything that does will throw.\n` +
    `To build it, install ${toolchain}, then reinstall this package.\n`,
);
process.exit(0);
