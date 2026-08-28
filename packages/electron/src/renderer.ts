import { ReaderStore, type ArenaReader, type Snapshot } from "@globals/core";

import { MARK, isOwnerToWindow, type Intent, type OwnerToWindow } from "./messages.js";

/**
 * What a UI window calls.
 *
 * The handshake runs entirely in the page's own world over `window.opener`, with no preload
 * and no context bridge involved. That is not a simplification for its own sake: a
 * MessagePort cannot cross a context bridge, and a SharedArrayBuffer cannot cross a
 * MessageChannelMain. Talking to the opener directly avoids both. See ADR 0002.
 *
 * The consequence is the largest constraint this library imposes: a window that needs the
 * shared tier must have been opened by the owner. A window created directly in the main
 * process has no opener, so it cannot be given the buffer.
 */

export interface SharedConnection {
  readonly tier: "shared";
  /** Synchronous. The whole point. */
  get(): unknown;
  select(path: readonly (string | number)[]): unknown;
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  /** Asynchronous, and the type says so. Resolves when the write is observable. */
  dispatch(operation: string, payload?: unknown): Promise<number>;
  /** Fetch a value from the asynchronous tier by handle. */
  external(handle: number): Promise<unknown>;
  /** The underlying reader, for diagnostics and a debug panel. */
  readonly reader: ArenaReader;
  /** The buffer, for a panel that wants to attach its own reader. */
  readonly buffer: SharedArrayBuffer;
  readonly version: number;
  close(): void;
}

export interface AsyncConnection {
  readonly tier: "async";
  /**
   * Asynchronous, because this window is not on the shared tier.
   *
   * The method name differs from the shared tier on purpose. Code written against one tier
   * does not silently compile against the other, so moving a window between tiers is a
   * decision the compiler makes you acknowledge.
   */
  read(): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  dispatch(operation: string, payload?: unknown): Promise<number>;
  external(handle: number): Promise<unknown>;
  readonly version: number;
  close(): void;
}

export type Connection = SharedConnection | AsyncConnection;

export interface ConnectOptions {
  /** How long to wait for the owner to answer. */
  timeoutMs?: number;
  /** A name the owner sees, so it can decide which tier this window belongs on. */
  name?: string;
}

/**
 * Connect this window to the owner.
 *
 * Resolves once the window holds either the buffer or its first replicated value, so a first
 * render reads real state rather than a placeholder. Call it before mounting.
 */
export function connect(options: ConnectOptions = {}): Promise<Connection> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const name = options.name ?? (globalThis as { name?: string }).name ?? "window";
  const opener = (globalThis as { opener?: unknown }).opener as
    | { postMessage(message: unknown, targetOrigin: string): void }
    | null
    | undefined;

  if (opener === null || opener === undefined) {
    return Promise.reject(
      new Error(
        "this window has no opener, so it cannot be given the buffer. A window that needs " +
          "the shared tier must be opened by the owner, which is what host.openWindow does. " +
          "See docs/electron.md.",
      ),
    );
  }

  return new Promise<Connection>((resolve, reject) => {
    const listeners = new Set<() => void>();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 1;
    let settled = false;
    let store: ReaderStore | undefined;
    let replica: unknown;
    let version = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      globalThis.removeEventListener("message", onMessage);
      reject(new Error(`the owner did not answer this window within ${timeoutMs} ms`));
    }, timeoutMs);

    const post = (message: Intent | { mark: string; kind: "hello"; name: string }): void => {
      opener.postMessage(message, "*");
    };

    const send = (intent: Intent): Promise<unknown> =>
      new Promise((resolveIntent, rejectIntent) => {
        pending.set(intent.id, { resolve: resolveIntent, reject: rejectIntent });
        post(intent);
      });

    const dispatch = (operation: string, payload?: unknown): Promise<number> => {
      const id = nextId;
      nextId += 1;
      return send({ mark: MARK, kind: "write", id, operation, payload }) as Promise<number>;
    };

    const external = (handle: number): Promise<unknown> => {
      const id = nextId;
      nextId += 1;
      return send({ mark: MARK, kind: "external", id, handle });
    };

    const notify = (): void => {
      for (const listener of listeners) listener();
    };

    const subscribe = (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };

    function sharedConnection(): SharedConnection {
      const reader = store as ReaderStore;
      return {
        tier: "shared",
        get: () => reader.get(),
        select: (path) => reader.select(path),
        snapshot: () => reader.snapshot(),
        subscribe,
        dispatch,
        external,
        reader: reader.reader,
        buffer: reader.reader.arena.buffer,
        get version() {
          return reader.version;
        },
        close() {
          reader.close();
          globalThis.removeEventListener("message", onMessage);
        },
      };
    }

    function asyncConnection(): AsyncConnection {
      return {
        tier: "async",
        read: async () => replica,
        subscribe,
        dispatch,
        external,
        get version() {
          return version;
        },
        close() {
          globalThis.removeEventListener("message", onMessage);
        },
      };
    }

    function onMessage(event: Event): void {
      const message = (event as unknown as { data: unknown }).data as OwnerToWindow;
      if (!isOwnerToWindow(message)) return;

      switch (message.kind) {
        case "bind": {
          store = new ReaderStore(message.buffer);
          version = message.version;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(sharedConnection());
          }
          return;
        }
        case "async-only": {
          replica = message.value;
          version = message.version;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(asyncConnection());
          }
          return;
        }
        case "replica": {
          replica = message.value;
          version = message.version;
          notify();
          return;
        }
        case "version": {
          version = message.version;
          store?.notify();
          notify();
          return;
        }
        case "result": {
          const waiter = pending.get(message.id);
          if (waiter === undefined) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.version ?? message.value);
          return;
        }
        default:
          return;
      }
    }

    globalThis.addEventListener("message", onMessage);
    // Announce only after the listener is installed, so a fast owner cannot answer before
    // there is anything listening.
    post({ mark: MARK, kind: "hello", name });
  });
}

/** True when this window can use the shared tier at all. */
export function isCrossOriginIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/**
 * A readable diagnosis of why the shared tier is unavailable.
 *
 * Returns undefined when everything the shared tier needs is in place.
 */
export function diagnose(): string | undefined {
  if ((globalThis as { opener?: unknown }).opener == null) {
    return (
      "this window has no opener. Only a window the owner opened can be given the buffer, " +
      "because that is the only channel a SharedArrayBuffer survives."
    );
  }
  if (!isCrossOriginIsolated()) {
    return (
      "this window is not cross origin isolated, so it cannot receive a SharedArrayBuffer. " +
      "Serve the application over the custom protocol so every response carries COOP and COEP."
    );
  }
  if (typeof SharedArrayBuffer === "undefined") {
    return "SharedArrayBuffer is not available in this window.";
  }
  return undefined;
}
