/**
 * @globals/electron
 *
 * The Electron integration: a hidden owner window that owns the arena, a bootstrap handshake
 * that hands each window its buffer before the first render, window lifecycle handling, and
 * persistence.
 *
 * Three entry points, one per process, and they are separate imports because a renderer
 * cannot load the Node built ins the main process side needs:
 *
 *   Main process   "@globals/electron"           GlobalsHost, prepare, preloadPath
 *   Owner window   "@globals/electron/owner"     startOwner
 *   UI window      "@globals/electron/renderer"  connect
 */

export { GlobalsHost, prepare } from "./host.js";
export type { HostOptions, OpenWindowOptions } from "./host.js";
export {
  DEFAULT_SCHEME,
  ISOLATION_HEADERS,
  pageUrl,
  registerScheme,
  resolveRequestPath,
  serveScheme,
} from "./protocol.js";
export type { ProtocolOptions } from "./protocol.js";
export { SnapshotStore } from "./persistence.js";
export type { PersistenceOptions } from "./persistence.js";
export { preloadPath } from "./preload-path.js";
export { CHANNEL, MARK, isOwnerToWindow, isWindowToOwner } from "./messages.js";
export type {
  BindMessage,
  Intent,
  OwnerToWindow,
  ResultMessage,
  VersionMessage,
  WindowToOwner,
  WriteIntent,
} from "./messages.js";
