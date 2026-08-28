/**
 * The wire protocol.
 *
 * Two channels, deliberately separate.
 *
 * The main process talks to the owner over ordinary Electron IPC. It carries window open
 * requests, main process reads, and main process writes. It never carries the buffer.
 *
 * The owner talks to each window it opened over Chromium's window messaging, directly. That
 * channel carries the buffer once, then intents and wakeups. It never carries reads, because
 * a read that depended on a message would break the contract this library exists to provide.
 *
 * The window channel is plain `postMessage` between an opener and the window it opened. It
 * is not a MessagePort and not a MessageChannelMain, and that is the whole finding of phase
 * 0: a SharedArrayBuffer does not survive either of those. See ADR 0002.
 */

/** Every message on the window channel carries this, so other traffic is ignored. */
export const MARK = "globals/1";

export const CHANNEL = {
  /** Main to owner. Asking the owner to open a window, because only it can. */
  OpenWindow: "globals:open-window",
  /** Owner to main. The result of an open request. */
  OpenResult: "globals:open-result",
  /** Main to owner. A read on behalf of the main process, asynchronous by nature. */
  MainRead: "globals:main-read",
  /** Main to owner. A write on behalf of the main process. */
  MainIntent: "globals:main-intent",
  /** Owner to main. The reply to either of the above. */
  MainReply: "globals:main-reply",
  /** Renderer to main. A window announcing it has loaded, for the async tier. */
  Ready: "globals:ready",
} as const;

/** A window telling its opener it is listening. The first thing on the window channel. */
export interface HelloMessage {
  readonly mark: typeof MARK;
  readonly kind: "hello";
  readonly name: string;
}

/** The owner handing a window the buffer. Sent once per window. */
export interface BindMessage {
  readonly mark: typeof MARK;
  readonly kind: "bind";
  readonly buffer: SharedArrayBuffer;
  readonly version: number;
  readonly ownerGeneration: number;
}

/** The owner telling a window it is on the asynchronous tier only. */
export interface AsyncOnlyMessage {
  readonly mark: typeof MARK;
  readonly kind: "async-only";
  readonly reason: string;
  readonly version: number;
  readonly value: unknown;
}

/** The owner pushing a full value to an async tier window after every commit. */
export interface ReplicaMessage {
  readonly mark: typeof MARK;
  readonly kind: "replica";
  readonly version: number;
  readonly value: unknown;
}

/**
 * The owner telling a window a new version exists.
 *
 * A wakeup, not a data path. A window that misses one still reads correct state, it just
 * rerenders later than it could have. Keeping it off the read path is what lets a render call
 * get() without waiting for anything.
 */
export interface VersionMessage {
  readonly mark: typeof MARK;
  readonly kind: "version";
  readonly version: number;
}

/** A window asking the owner to write. Named operations, not arbitrary functions. */
export interface WriteIntent {
  readonly mark: typeof MARK;
  readonly kind: "write";
  readonly id: number;
  readonly operation: string;
  readonly payload: unknown;
}

/** A window asking the owner for a value from the asynchronous tier. */
export interface ExternalIntent {
  readonly mark: typeof MARK;
  readonly kind: "external";
  readonly id: number;
  readonly handle: number;
}

export interface ResultMessage {
  readonly mark: typeof MARK;
  readonly kind: "result";
  readonly id: number;
  readonly version?: number;
  readonly value?: unknown;
  readonly error?: { name: string; message: string };
}

export type Intent = WriteIntent | ExternalIntent;
export type WindowToOwner = HelloMessage | Intent;
export type OwnerToWindow = BindMessage | AsyncOnlyMessage | ReplicaMessage | VersionMessage | ResultMessage;

function marked(value: unknown): value is { mark: string; kind: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { mark?: unknown }).mark === MARK &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function isWindowToOwner(value: unknown): value is WindowToOwner {
  if (!marked(value)) return false;
  if (value.kind === "hello") return true;
  const candidate = value as { id?: unknown };
  if (typeof candidate.id !== "number") return false;
  return value.kind === "write" || value.kind === "external";
}

export function isOwnerToWindow(value: unknown): value is OwnerToWindow {
  if (!marked(value)) return false;
  return (
    value.kind === "bind" ||
    value.kind === "async-only" ||
    value.kind === "replica" ||
    value.kind === "version" ||
    value.kind === "result"
  );
}
