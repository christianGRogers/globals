/**
 * @globals/electron
 *
 * The Electron integration: a hidden owner window that owns the arena, a bootstrap handshake
 * that hands each window its buffer before the first render, window lifecycle handling, and
 * persistence.
 *
 * Three entry points, one per process:
 *
 *   Main process   GlobalsHost, plus prepare() at module scope
 *   Owner window   startOwner()
 *   UI window      connect()
 */

export { GlobalsHost, prepare } from "./host.js";
export type { HostOptions, AttachOptions } from "./host.js";
export { startOwner } from "./owner-page.js";
export type { StartOwnerOptions } from "./owner-page.js";
export { createOwnerRuntime } from "./owner-runtime.js";
export type {
  MessagePortLike,
  Operation,
  OwnerRuntime,
  OwnerRuntimeOptions,
} from "./owner-runtime.js";
export { connect, diagnose, isCrossOriginIsolated } from "./renderer.js";
export type { AsyncConnection, Connection, SharedConnection } from "./renderer.js";
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
export { CHANNEL, isIntent, isOwnerToWindow } from "./messages.js";
export type {
  BindMessage,
  Intent,
  IntentResult,
  OwnerToWindow,
  VersionNotice,
  WriteIntent,
} from "./messages.js";
