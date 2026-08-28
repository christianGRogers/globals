/**
 * The owner window entry point.
 *
 * Separate from the package root on purpose. The root exports the main process API, which
 * imports Electron and Node built ins, and a renderer cannot load those: the request for
 * `node:fs/promises` leaves the custom scheme and Chromium refuses it as a cross origin
 * script. A page importing the root gets a CORS error that says nothing about the real
 * problem.
 *
 * So the processes get separate entry points, and the boundary is enforced by what each one
 * is allowed to import rather than by a convention in the documentation.
 *
 *   import { startOwner } from "@globals/electron/owner";
 */
export { startOwner } from "./owner-page.js";
export type { StartOwnerOptions } from "./owner-page.js";
export { createOwnerRuntime } from "./owner-runtime.js";
export type {
  Operation,
  OwnerRuntime,
  OwnerRuntimeOptions,
  WindowLike,
} from "./owner-runtime.js";
export { CHANNEL, MARK, isOwnerToWindow, isWindowToOwner } from "./messages.js";
export type { Intent, OwnerToWindow, WindowToOwner } from "./messages.js";
