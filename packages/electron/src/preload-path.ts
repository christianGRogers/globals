import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The absolute path to the preload bridge.
 *
 * The preload is hand written CommonJS shipped beside the compiled output rather than
 * produced by the TypeScript build, because a sandboxed preload cannot be an ES module.
 * Resolving it relative to this file keeps it working whether the package is installed, in a
 * workspace, or bundled by an application packager that preserves the package layout.
 */
export function preloadPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src/preload-path.js, so the package root is two levels up.
  return join(here, "..", "..", "preload.cjs");
}
