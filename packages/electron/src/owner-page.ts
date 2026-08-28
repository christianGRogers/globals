import { createOwnerRuntime, type OwnerRuntime, type OwnerRuntimeOptions } from "./owner-runtime.js";

/**
 * What the hidden owner page calls.
 *
 * It wires the runtime to the two things only a real window has: the ports the main process
 * hands over, and the request channel the main process uses for its own reads and writes.
 */

interface OwnerBridge {
  onPort(listener: (port: MessagePort, payload: { name: string }) => void): () => void;
  ready(): void;
  onMainRequest(listener: (channel: string, request: { id: number; payload: unknown }) => void): void;
  replyToMain(reply: { id: number; value?: unknown; error?: { message: string } }): void;
  channels: Record<string, string>;
  environment: { sandboxed: boolean; contextIsolated: boolean };
}

function bridge(): OwnerBridge {
  const found = (globalThis as { __globals?: OwnerBridge }).__globals;
  if (found === undefined) {
    throw new Error(
      "the globals preload is not installed on the owner window. Pass preloadPath() as the " +
        "preload in webPreferences.",
    );
  }
  return found;
}

export interface StartOwnerOptions<State> extends OwnerRuntimeOptions<State> {
  /**
   * Called after every commit with the detached state and its version.
   *
   * Wire it to the host persistence bridge if the application persists state. It runs on
   * every commit, so it must not do work proportional to the state, which is why the value
   * handed over is already materialised once rather than re-decoded per listener.
   */
  onCommit?: (version: number, snapshot: unknown) => void;
}

/**
 * Start the owner runtime inside the hidden window.
 *
 * Returns the runtime so the owner page can drive it directly, which is how a background
 * task, a timer, or a socket in the owner window writes state without going through an
 * intent.
 */
export function startOwner<State>(options: StartOwnerOptions<State>): OwnerRuntime<State> {
  const api = bridge();

  if (!api.environment.sandboxed || !api.environment.contextIsolated) {
    console.warn(
      "globals: the owner window is not sandboxed and context isolated. The trust model " +
        "assumes both, and the phase 0 gate requires them.",
    );
  }

  if ((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== true) {
    throw new Error(
      "the owner window is not cross origin isolated, so it cannot allocate a shareable " +
        "SharedArrayBuffer. Serve the owner page over the custom protocol, which sets COOP " +
        "and COEP on every response.",
    );
  }

  const runtime = createOwnerRuntime(options);

  api.onPort((port, payload) => {
    runtime.bind(port as unknown as Parameters<typeof runtime.bind>[0], payload.name);
  });

  api.onMainRequest((channel, request) => {
    try {
      if (channel === api.channels.MainRead) {
        api.replyToMain({ id: request.id, value: runtime.read() });
        return;
      }
      const { operation, payload } = request.payload as { operation: string; payload: unknown };
      api.replyToMain({ id: request.id, value: runtime.apply(operation, payload) });
    } catch (error) {
      api.replyToMain({
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  api.ready();
  return runtime;
}
