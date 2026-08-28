import { ReaderStore, type Snapshot } from "@globals/core";

import { isOwnerToWindow, type Intent, type OwnerToWindow } from "./messages.js";

/**
 * What a UI window calls.
 *
 * Two tiers, with the same write API and deliberately different read APIs, so which tier a
 * window is on is visible in the code rather than in a configuration file.
 */

interface Bridge {
  onPort(listener: (port: MessagePort, payload: { name: string }) => void): () => void;
  ready(): void;
  rebind(): void;
  environment: { sandboxed: boolean; contextIsolated: boolean };
}

function bridge(): Bridge {
  const found = (globalThis as { __globals?: Bridge }).__globals;
  if (found === undefined) {
    throw new Error(
      "the globals preload is not installed on this window. Pass preloadPath() as the " +
        "preload in webPreferences.",
    );
  }
  return found;
}

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
  readonly version: number;
  close(): void;
}

export interface AsyncConnection {
  readonly tier: "async";
  /**
   * Asynchronous, because this window opted out of shared memory.
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

/**
 * Connect this window to the owner.
 *
 * Resolves once the window has been given either the buffer or its first replicated value,
 * so a first render reads real state rather than a placeholder. Call it before mounting.
 */
export function connect(options: { timeoutMs?: number } = {}): Promise<Connection> {
  const api = bridge();

  if (!api.environment.contextIsolated) {
    // Not a hard failure, because an application may have its own reasons, but it is a
    // security relevant deviation and it should not pass silently.
    console.warn(
      "globals: this window is not context isolated. The trust model in docs assumes it is.",
    );
  }

  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<Connection>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`the owner did not bind this window within ${timeoutMs} ms`));
    }, timeoutMs);

    const unsubscribe = api.onPort((port) => {
      const listeners = new Set<() => void>();
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      let nextId = 1;
      let settled = false;
      let store: ReaderStore | undefined;
      let replica: unknown;
      let version = 0;

      const send = (intent: Intent): Promise<unknown> =>
        new Promise((resolveIntent, rejectIntent) => {
          pending.set(intent.id, { resolve: resolveIntent, reject: rejectIntent });
          port.postMessage(intent);
        });

      const dispatch = (operation: string, payload?: unknown): Promise<number> => {
        const id = nextId;
        nextId += 1;
        return send({ kind: "write", id, operation, payload }) as Promise<number>;
      };

      const external = (handle: number): Promise<unknown> => {
        const id = nextId;
        nextId += 1;
        return send({ kind: "external", id, handle });
      };

      const notify = (): void => {
        for (const listener of listeners) listener();
      };

      port.addEventListener("message", (event: MessageEvent) => {
        const message = event.data as OwnerToWindow;
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
      });
      port.start();

      function sharedConnection(): SharedConnection {
        const reader = store as ReaderStore;
        return {
          tier: "shared",
          get: () => reader.get(),
          select: (path) => reader.select(path),
          snapshot: () => reader.snapshot(),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispatch,
          external,
          get version() {
            return reader.version;
          },
          close() {
            reader.close();
            port.close();
          },
        };
      }

      function asyncConnection(): AsyncConnection {
        return {
          tier: "async",
          read: async () => replica,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispatch,
          external,
          get version() {
            return version;
          },
          close() {
            port.close();
          },
        };
      }
    });

    // Announce readiness after the listener is installed, so a fast owner cannot answer
    // before there is anything listening.
    api.ready();
  });
}

/** True when this window can use the shared tier at all. */
export function isCrossOriginIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/**
 * A readable diagnosis of why the shared tier is unavailable, for an error message worth
 * reading. Returns undefined when everything the shared tier needs is in place.
 */
export function diagnose(): string | undefined {
  if (!isCrossOriginIsolated()) {
    return (
      "this window is not cross origin isolated, so it cannot receive a SharedArrayBuffer. " +
      "Serve the application over the custom protocol so every response carries COOP and " +
      "COEP."
    );
  }
  if (typeof SharedArrayBuffer === "undefined") {
    return "SharedArrayBuffer is not available in this window.";
  }
  return undefined;
}
