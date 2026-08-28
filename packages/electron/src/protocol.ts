import { protocol, net } from "electron";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  DEFAULT_SCHEME,
  ISOLATION_HEADERS,
  MIME,
  pageUrl,
  resolveRequestPath,
} from "./paths.js";

/**
 * The custom protocol.
 *
 * `SharedArrayBuffer` is only transferable between renderers when they are cross origin
 * isolated, and a renderer is cross origin isolated only when the document that created it
 * carried COOP and COEP. Electron cannot set those headers on `file://`, so the application
 * has to be served through a scheme this library controls.
 *
 * That is the constraint behind the awkward part of adoption: an application that loads its
 * UI from `file://` has to move to a custom scheme before it can use the shared tier. There
 * is no way around it that keeps the sandbox on.
 *
 * The path resolution lives in paths.ts, which imports nothing from Electron so that it can
 * be tested by a plain Node test runner.
 */

export interface ProtocolOptions {
  /** Scheme name. Must be registered before the app is ready. */
  scheme?: string;
  /**
   * Directory served for the scheme. Requests cannot escape it.
   *
   * Everything the pages import has to be inside it. A specifier that climbs above the root
   * is collapsed by the browser before the request arrives, so it becomes a 404 rather than
   * a file from the directory above.
   */
  root: string;
  /** Served when a request has no path. */
  index?: string;
  /** Forwarded to an upstream dev server instead of the filesystem, if given. */
  devServer?: string;
}

/**
 * Register the scheme as privileged.
 *
 * Must be called at module scope in the main process, before `app.whenReady()`. Electron
 * ignores a registration made after the app is ready, and the failure mode is a renderer
 * that silently is not cross origin isolated, which shows up much later as a buffer that
 * cannot be transferred.
 */
export function registerScheme(scheme: string = DEFAULT_SCHEME): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Start serving the scheme. Call after the app is ready.
 *
 * Every response carries the isolation headers, including error responses, because a
 * document that loads without them is not isolated and the whole handshake fails later for
 * a reason that is hard to trace back to here.
 */
export function serveScheme(options: ProtocolOptions): void {
  const scheme = options.scheme ?? DEFAULT_SCHEME;
  const root = options.root;
  const index = options.index ?? "index.html";

  protocol.handle(scheme, async (request) => {
    const url = new URL(request.url);

    if (options.devServer !== undefined) {
      // A dev server does not set COOP and COEP, so its responses are re-headed here.
      // Without this, development would silently lose cross origin isolation and the shared
      // tier would only work in a production build.
      const upstream = new URL(url.pathname + url.search, options.devServer);
      const response = await net.fetch(upstream.toString(), {
        method: request.method,
        headers: request.headers,
      });
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    }

    const file = resolveRequestPath(root, url.pathname, index);
    if (file === undefined) {
      return new Response("forbidden", { status: 403, headers: ISOLATION_HEADERS });
    }

    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          ...ISOLATION_HEADERS,
          "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        },
      });
    } catch {
      return new Response("not found", { status: 404, headers: ISOLATION_HEADERS });
    }
  });
}

export { DEFAULT_SCHEME, ISOLATION_HEADERS, pageUrl, resolveRequestPath };
