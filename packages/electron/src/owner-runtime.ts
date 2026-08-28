import {
  ArenaOwner,
  ExternalRef,
  ExternalTier,
  LivenessMonitor,
  type OwnerOptions,
  type OwnerStats,
} from "@globals/core";

import { CHANNEL, isIntent, type Intent, type OwnerToWindow } from "./messages.js";

/**
 * What runs inside the hidden owner window.
 *
 * The owner is a renderer, not the Node main process. That is the central claim of the
 * architecture: only a renderer can share a SharedArrayBuffer with other renderers on a path
 * Chromium actually supports. See docs/adr/0001-hidden-owner-window.md.
 *
 * This module is loaded by the owner page, which is an ordinary bundle the application
 * supplies. It has no Node access and does not need any.
 */

/**
 * A named write.
 *
 * Functions cannot cross a process boundary, so a window cannot send a recipe. It sends the
 * name of an operation the owner has registered and a structured clone friendly payload.
 * The set of possible writes is therefore declared in one place, which is also what makes
 * the trust boundary reviewable: a window can only do what the owner offers.
 */
export type Operation<State = never, Payload = unknown> = (
  draft: State,
  payload: Payload,
) => void;

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
  /** Windows that must not receive the buffer, by the name they bound with. */
  asyncOnly?: (name: string) => boolean;
}

interface Peer {
  readonly port: MessagePort;
  readonly name: string;
  readonly shared: boolean;
}

/**
 * A port endpoint, as the owner sees it.
 *
 * Deliberately structural rather than the DOM MessagePort type, so this module can be unit
 * tested against a pair of fake ports without a window.
 */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

export interface OwnerRuntime<State> {
  readonly owner: ArenaOwner;
  readonly tier: ExternalTier;
  /** Attach a window that has sent its port. */
  bind(port: MessagePortLike, name: string): void;
  /** Apply a named operation, as if a window had asked for it. */
  apply(operation: string, payload: unknown): number;
  /** Apply a recipe directly. Only the owner can do this, because only it holds the arena. */
  update(recipe: (draft: State) => void): number;
  /** Replace the root outright. */
  set(value: State): number;
  read(): unknown;
  stats(): OwnerStats & { peers: number; reaped: number; external: number };
  dispose(): void;
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

  function announce(version: number): void {
    const notice: OwnerToWindow = { kind: "version", version };
    for (const peer of peers) {
      // A window on the asynchronous tier gets the value, because it has no arena to read.
      // A shared tier window gets a wakeup only, because it already has the data.
      peer.port.postMessage(
        peer.shared ? notice : { kind: "replica", version, value: snapshot() },
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

  function handleIntent(peer: Peer, intent: Intent): void {
    try {
      if (intent.kind === "write") {
        const version = applyOperation(intent.operation, intent.payload);
        peer.port.postMessage({ kind: "result", id: intent.id, version });
        return;
      }
      const value = tier.serve(intent.handle);
      peer.port.postMessage({ kind: "result", id: intent.id, value });
    } catch (error) {
      peer.port.postMessage({
        kind: "result",
        id: intent.id,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return {
    owner,
    tier,

    bind(port, name) {
      const shared = !(options.asyncOnly?.(name) ?? false);
      const peer: Peer = { port: port as unknown as MessagePort, name, shared };
      peers.add(peer);

      port.addEventListener("message", (event) => {
        if (!isIntent(event.data)) return;
        handleIntent(peer, event.data);
      });
      port.start?.();

      if (shared) {
        port.postMessage({
          kind: "bind",
          buffer: owner.buffer,
          version: owner.versionId,
          ownerGeneration: owner.arena.ownerGeneration,
        });
        return;
      }

      // The per window opt out from the trust model. This window never receives the buffer,
      // so it cannot corrupt shared state, and it pays for that with asynchronous reads.
      port.postMessage({
        kind: "async-only",
        reason: "this window opted out of the shared tier",
        version: owner.versionId,
        value: snapshot(),
      });
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
      for (const peer of peers) peer.port.close?.();
      peers.clear();
    },
  };
}

export { CHANNEL, ExternalRef };
