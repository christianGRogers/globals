/**
 * Filesystem locations the main process needs to hand to webPreferences. A module rather
 * than a constant, because the path is only knowable relative to the installed package.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** The shipped preload for the asynchronous tier: sandboxed windows that read by asking. */
export function asyncPreloadPath(): string {
  // dist/src/native/paths.js sits three directories below the package root.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "preload-async.cjs");
}
