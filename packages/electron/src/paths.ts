import { join, normalize, sep } from "node:path";

/**
 * Serving logic with no Electron import in it.
 *
 * Kept separate for a practical reason. Outside an Electron process the `electron` module is
 * a shim whose only export is the path to the binary, so anything that imports it cannot be
 * loaded by a plain Node test runner. Putting the path resolution here means the security
 * relevant part of serving files can be tested directly, which is worth more than keeping it
 * next to the code that calls it.
 */

export const DEFAULT_SCHEME = "globals-app";

/** The headers that make `crossOriginIsolated` true. */
export const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
} as const;

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Turn a request pathname into a file inside the served root, or undefined when it escapes.
 *
 * A traversal that reaches outside the root is not a missing file, it is a hole, so the
 * segments are filtered after decoding and the result is checked against the root again.
 *
 * The rule that catches application authors is the ordinary one: **a page can only import
 * what the served root contains.** An import that climbs above the root with `..` never
 * reaches the filesystem above it, because the browser resolves the specifier against the
 * scheme origin first and the climb is already collapsed by the time the request arrives.
 * Serve a root that contains everything the pages import.
 */
export function resolveRequestPath(
  root: string,
  pathname: string,
  index: string,
): string | undefined {
  const normalisedRoot = normalize(root);
  const segments = decodeURIComponent(pathname)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");

  const file = normalize(
    segments.length === 0 ? join(normalisedRoot, index) : join(normalisedRoot, ...segments),
  );

  if (file !== normalisedRoot && !file.startsWith(normalisedRoot + sep)) return undefined;
  return file;
}

/** The URL a window should load for a page under the served root. */
export function pageUrl(page: string, scheme: string = DEFAULT_SCHEME): string {
  return `${scheme}://app/${page.replace(/^\/+/u, "")}`;
}
