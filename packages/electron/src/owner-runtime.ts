import {
  ArenaOwner,
  ExternalRef,
  ExternalTier,
  LivenessMonitor,
  type OwnerOptions,
  type OwnerStats,
} from "@globals/core";

import {
  CHANNEL,
  MARK,
  isWindowToOwner,
  type Intent,
  type OwnerToWindow,
} from "./messages.js";

/**
 * What runs inside the hidden owner window.
 *
 * The owner is a renderer, not the Node main process. That is the central claim of the
 * architecture: only a renderer can share a SharedArrayBuffer with other renderers on a path
 * Chromium actually supports. See docs/adr/0001-hidden-owner-window.md.
 *
 * It is also the process that opens every window needing the shared tier, because a buffer
 * only crosses between an opener and the window it opened. See
 * docs/adr/0002-window-open-handshake.md.
 */

/**
 * A named write.
 *
 * Functions cannot cross a process boundary, so a window cannot send a recipe. It sends the
 * name of an operation the owner has registered and a structured clone friendly payload. The
 * set of possible writes is therefore declared in one place, which is also what makes the
 * trust boundary reviewable: a window can only do what the owner offers.
 */
export type Operation<State = never, Payload = unknown> = (
  draft: State,
  payload: Payload,
) => void;

/** The subset of a window reference this module needs, so it can be faked in a test. */
export interface WindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
  readonly closed?: boolean;
}

export interface OwnerRuntimeOptions<State> {
  /** State to commit when there is nothing to rehydrate. */
  initial: State;
  /** The writes windows are allowed to ask for. */
  operations: Record<string, Operation<never, never>>;
  arena?: OwnerOptions;
  /** Sampling interval and patience for declaring a reader dead. */
  liveness?: { intervalMs?: number; missesBeforeDead?: number };
  /** Called after every commit, for persistence and for diagnostics. */
  onCommit?: (version: number, snapshot: unknown) => void;
  /** Windows that must not receive the buffer, by the name they announced. */
  asyncOnly?: (name: string) => boolean;
  /** How a window is opened. Replaced in tests. Defaults to window.open. */
  open?: (url: string, name: string, features?: string) => WindowLike | null;
  /** Where window messages arrive. Replaced in tests. Defaults to the global window. */
  listen?: (handler: (data: unknown, source: WindowLike | null) => void) => void;
}

export interface OwnerRuntime<State> {
  readonly owner: ArenaOwner;
  readonly tier: ExternalTier;
  /** Open a window that will share the buffer. Only the owner can do this usefully. */
  openWindow(url: string, name: string, features?: string): boolean;
  /** Apply a named operation, as if a window had asked for it. */
  apply(operation: string, payload: unknown): number;
  /** Apply a recipe directly. Only the owner can, because only it holds the arena. */
  update(recipe: (draft: State) => void): number;
  /** Replace the root outright. */
  set(value: State): number;
  read(): unknown;
  stats(): OwnerStats & { peers: number; reaped: number; external: number };
  dispose(): void;
}

interface Peer {
  readonly target: WindowLike;
  readonly name: string;
  readonly shared: boolean;
}

export function createOwnerRuntime<State>(
  options: OwnerRuntimeOptions<State>,
): OwnerRuntime<State> {
  const owner = ArenaOwner.create(options.arena ?? {});
  const tier = new ExternalTier();
  const peers = new Set<Peer>();

  owner.commit(options.initial);

  const liveness = new LivenessMonitor(owner, {
    intervalMs: options.liveness?.intervalMs ?? 1000,
    missesBeforeDead: options.liveness?.missesBeforeDead ?? 5,
  });
  liveness.start();

  const snapshot = (): unknown => owner.readSnapshot();

  const send = (peer: Peer, message: OwnerToWindow): void => {
    try {
      // A window that has gone leaves a stale reference behind. Posting to it is not worth
      // taking the owner down for, and the liveness detector reclaims its slot anyway.
      if (peer.target.closed === true) {
        peers.delete(peer);
        return;
      }
      peer.target.postMessage(message, "*");
    } catch {
      peers.delete(peer);
    }
  };

  function announce(version: number): void {
    for (const peer of peers) {
      // A shared tier window already has the data and only needs waking. An asynchronous tier
      // window has no arena to read, so it gets the value.
      send(
        peer,
        peer.shared
          ? { mark: MARK, kind: "version", version }
          : { mark: MARK, kind: "replica", version, value: snapshot() },
      );
    }
    options.onCommit?.(version, snapshot());
  }

  function applyOperation(operation: string, payload: unknown): number {
    const handler = options.operations[operation];
    if (handler === undefined) {
      throw new Error(
        `no operation named ${JSON.stringify(operation)} is registered. A window can only ` +
          "ask for writes the owner offers, which is what keeps the write surface reviewable.",
      );
    }
    const version = owner.update((draft: never) => handler(draft, payload as never));
    announce(version);
    return version;
  }

  function greet(name: string, source: WindowLike): void {
    const shared = !(options.asyncOnly?.(name) ?? false);
    const peer: Peer = { target: source, name, shared };
    peers.add(peer);

    if (shared) {
      send(peer, {
        mark: MARK,
        kind: "bind",
        buffer: owner.buffer,
        version: owner.versionId,
        ownerGeneration: owner.arena.ownerGeneration,
      });
      return;
    }

    // The per window opt out from the trust model. This window never receives the buffer, so
    // it cannot corrupt shared state, and it pays for that with asynchronous reads.
    send(peer, {
      mark: MARK,
      kind: "async-only",
      reason: "this window opted out of the shared tier",
      version: owner.versionId,
      value: snapshot(),
    });
  }

  function handleIntent(source: WindowLike, intent: Intent): void {
    const peer = [...peers].find((candidate) => candidate.target === source) ?? {
      target: source,
      name: "unknown",
      shared: false,
    };
    try {
      if (intent.kind === "write") {
        const version = applyOperation(intent.operation, intent.payload);
        send(peer, { mark: MARK, kind: "result", id: intent.id, version });
        return;
      }
      send(peer, { mark: MARK, kind: "result", id: intent.id, value: tier.serve(intent.handle) });
    } catch (error) {
      send(peer, {
        mark: MARK,
        kind: "result",
        id: intent.id,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const listen =
    options.listen ??
    ((handler: (data: unknown, source: WindowLike | null) => void) => {
      globalThis.addEventListener("message", (event) => {
        const message = event as unknown as { data: unknown; source: WindowLike | null };
        handler(message.data, message.source);
      });
    });

  listen((data, source) => {
    if (source === null || !isWindowToOwner(data)) return;
    if (data.kind === "hello") {
      greet(data.name, source);
      return;
    }
    handleIntent(source, data);
  });

  const open =
    options.open ??
    ((url: string, name: string, features?: string) =>
      globalThis.open(url, name, features) as unknown as WindowLike | null);

  return {
    owner,
    tier,

    openWindow(url, name, features) {
      const child = open(url, name, features);
      // The child announces itself when it loads, and that is when it is bound. Binding here
      // would race the page's own script.
      return child !== null;
    },

    apply: applyOperation,

    update(recipe) {
      const version = owner.update(recipe);
      announce(version);
      return version;
    },

    set(value) {
      const version = owner.commit(value);
      announce(version);
      return version;
    },

    read: snapshot,

    stats() {
      return {
        ...owner.stats(),
        peers: peers.size,
        reaped: liveness.reapedCount,
        external: tier.size,
      };
    },

    dispose() {
      liveness.stop();
      peers.clear();
    },
  };
}

export { CHANNEL, ExternalRef };
