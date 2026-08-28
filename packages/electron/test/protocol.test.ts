import { test } from "node:test";
import assert from "node:assert/strict";
import { join, normalize, sep } from "node:path";

import { resolveRequestPath } from "../src/paths.js";

/**
 * Path resolution for the custom scheme.
 *
 * This is the security relevant part of serving files, so it is tested directly rather than
 * through a running Electron process. A traversal that reaches outside the root is not a
 * missing file, it is a hole.
 *
 * It is also where the first thing that bites an application author lives: a page can only
 * import what the served root contains.
 */

const ROOT = normalize(join("C:", "app", "renderer"));

test("an empty path serves the index", () => {
  assert.equal(resolveRequestPath(ROOT, "/", "index.html"), join(ROOT, "index.html"));
  assert.equal(resolveRequestPath(ROOT, "", "index.html"), join(ROOT, "index.html"));
});

test("a plain path resolves inside the root", () => {
  assert.equal(resolveRequestPath(ROOT, "/table.html", "index.html"), join(ROOT, "table.html"));
  assert.equal(
    resolveRequestPath(ROOT, "/assets/app.js", "index.html"),
    join(ROOT, "assets", "app.js"),
  );
});

test("a percent encoded path is decoded", () => {
  assert.equal(
    resolveRequestPath(ROOT, "/my%20page.html", "index.html"),
    join(ROOT, "my page.html"),
  );
});

test("traversal segments are stripped rather than followed", () => {
  // The browser normally collapses these before the request arrives. A request forged by
  // something other than a browser does not have to.
  assert.equal(
    resolveRequestPath(ROOT, "/../../../etc/passwd", "index.html"),
    join(ROOT, "etc", "passwd"),
  );
  assert.equal(
    resolveRequestPath(ROOT, "/assets/../../secret.txt", "index.html"),
    join(ROOT, "assets", "secret.txt"),
  );
});

test("an encoded traversal is stripped too", () => {
  // %2e%2e decodes to .. after the split would have caught it, so the order of decode and
  // filter matters. Decoding first is what makes this safe.
  const resolved = resolveRequestPath(ROOT, "/%2e%2e/%2e%2e/secret.txt", "index.html");
  assert.equal(resolved, join(ROOT, "secret.txt"));
  assert.ok(resolved !== undefined && resolved.startsWith(ROOT + sep));
});

test("every resolved path stays inside the root", () => {
  const attempts = [
    "/",
    "/a.html",
    "/../x",
    "/../../x",
    "/a/../../x",
    "/%2e%2e/x",
    "/.//./x",
    "/a/b/c/../../../../x",
  ];
  for (const attempt of attempts) {
    const resolved = resolveRequestPath(ROOT, attempt, "index.html");
    assert.ok(resolved !== undefined, `${attempt} was rejected outright, which is also fine`);
    assert.ok(
      resolved === ROOT || resolved.startsWith(ROOT + sep),
      `${attempt} escaped the root as ${resolved}`,
    );
  }
});

test("a page can only reach what the served root contains", () => {
  // The failure that bites an application author, stated as a test so it is discovered here
  // rather than as a blank window.
  //
  // A page at /renderer/owner.html importing "../../packages/core/dist/index.js" is resolved
  // by the browser against the scheme origin first, so what arrives is
  // /packages/core/dist/index.js with the climb already collapsed. Serving a root that does
  // not contain that path gives a 404, and the window loads nothing.
  const arriving = "/packages/core/dist/src/index.js";
  const resolved = resolveRequestPath(ROOT, arriving, "index.html");

  assert.equal(resolved, join(ROOT, "packages", "core", "dist", "src", "index.js"));
  assert.ok(
    resolved !== undefined && !resolved.includes(join("C:", "app", "packages")),
    "the request cannot reach a sibling of the root, which is the point",
  );
});
