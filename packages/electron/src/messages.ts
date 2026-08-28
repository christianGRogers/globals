/**
 * The wire protocol between the main process, the owner window, and the UI windows.
 *
 * Two channels, deliberately separate:
 *
 *   The bootstrap channel is ordinary Electron IPC. It carries the port handoff and nothing
 *   else, and it runs once per window.
 *
 *   The intent channel is a MessagePort between a window and the owner. It carries writes
 *   and wakeups. It never carries reads, because a read that depended on a message would
 *   break the contract this library exists to provide.
 */

export const CHANNEL = {
  /** Main to renderer. Carries the port a window uses to talk to the owner. */
  Port: "globals:port",
  /** Renderer to main. A window announcing it is ready for its port. */
  Ready: "globals:ready",
  /** Renderer to main. A window asking for the current buffer again after a reload. */
  Rebind: "globals:rebind",
  /** Main to renderer, owner only. The main process asking the owner to apply an intent. */
  MainIntent: "globals:main-intent",
  /** Owner to main. The result of a main process intent, or a read reply. */
  MainReply: "globals:main-reply",
  /** Main to owner. A read on behalf of the main process, which is asynchronous by nature. */
  MainRead: "globals:main-read",
} as const;

export type IntentId = number;

/** A window asking the owner to write. Named operations, not arbitrary functions. */
export interface WriteIntent {
  readonly kind: "write";
  readonly id: IntentId;
  /** The operation name the owner has a handler registered for. */
  readonly operation: string;
  /** Structured clone friendly payload. */
  readonly payload: unknown;
}

/** A window asking the owner for a value from the asynchronous tier. */
export interface ExternalFetchIntent {
  readonly kind: "external";
  readonly id: IntentId;
  readonly handle: number;
}

export type Intent = WriteIntent | ExternalFetchIntent;

export interface IntentResult {
  readonly kind: "result";
  readonly id: IntentId;
  readonly version?: number;
  readonly value?: unknown;
  readonly error?: { name: string; message: string };
}

/**
 * The owner telling a window a new version exists.
 *
 * This is a wakeup, not a data path. A window that misses one still reads correct state, it
 * just rerenders later than it could have. Keeping it off the read path is what lets a
 * render call `get()` without waiting for anything.
 */
export interface VersionNotice {
  readonly kind: "version";
  readonly version: number;
}

/** The owner handing a window the buffer. Sent once per bind, over the port. */
export interface BindMessage {
  readonly kind: "bind";
  readonly buffer: SharedArrayBuffer;
  readonly version: number;
  readonly ownerGeneration: number;
}

/** The owner telling a window it is on the asynchronous tier only. */
export interface AsyncOnlyMessage {
  readonly kind: "async-only";
  readonly reason: string;
  readonly version: number;
  readonly value: unknown;
}

/** The owner pushing a full value to an async tier window after every commit. */
export interface ReplicaMessage {
  readonly kind: "replica";
  readonly version: number;
  readonly value: unknown;
}

export type OwnerToWindow = BindMessage | AsyncOnlyMessage | ReplicaMessage | VersionNotice | IntentResult;
export type WindowToOwner = Intent;

export function isOwnerToWindow(value: unknown): value is OwnerToWindow {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "bind" ||
    kind === "async-only" ||
    kind === "replica" ||
    kind === "version" ||
    kind === "result"
  );
}

export function isIntent(value: unknown): value is Intent {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; id?: unknown };
  if (typeof candidate.id !== "number") return false;
  return candidate.kind === "write" || candidate.kind === "external";
}
