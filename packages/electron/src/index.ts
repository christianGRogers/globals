/**
 * @globals/electron
 *
 * The Electron integration over the native transport. The owner is a plain object in the
 * main process; each window that shares memory maps the region file from its preload; a
 * window that keeps its sandbox gets the asynchronous tier instead. There is no hidden
 * owner window, no privileged scheme, and no handshake: the machinery this package once
 * carried for the window.open topology was deleted when ADR 0003 landed, and the history
 * holds it.
 *
 * Two entry points, one per process side:
 *
 *   Main process   "@globals/electron"           startNativeOwner, asyncPreloadPath
 *   Preload        "@globals/electron/preload"   connectNative, for sandbox: false windows
 *
 * A sandboxed window loads the shipped preload-async.cjs (located by asyncPreloadPath) and
 * reads by asking; it never maps the region.
 */

export { startNativeOwner, asyncPreloadPath } from "./native/owner.js";
export type { StartNativeOwnerOptions } from "./native/owner.js";
export { createNativeOwner, restoreNativeOwner } from "./native/owner-core.js";
export type { NativeOperation, NativeOwner, NativeOwnerOptions } from "./native/owner-core.js";
export { SnapshotStore } from "./persistence.js";
export type { PersistenceOptions } from "./persistence.js";
export { NATIVE_CHANNEL, HELLO, DISPATCH, COMMIT, READ } from "./native/channel.js";
export type { DispatchMessage, Hello } from "./native/channel.js";
