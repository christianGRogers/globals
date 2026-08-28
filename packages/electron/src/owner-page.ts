import { createOwnerRuntime, type OwnerRuntime, type OwnerRuntimeOptions } from "./owner-runtime.js";
import { CHANNEL } from "./messages.js";

/**
 * What the hidden owner page calls.
 *
 * It wires the runtime to the two things only this window can do: open the windows that will
 * share the buffer, and answer the main process.
 */

interface OwnerBridge {
  onMainRequest(
    listener: (channel: string, request: { id: number; payload: unknown }) => void,
  ): void;
  reply(channel: string, message: unknown): void;
  channels: Record<string, string>;
  environment: { sandboxed: boolean; contextIsolated: boolean };
}

function bridge(): OwnerBridge {
  const found = (globalThis as { __globalsOwner?: OwnerBridge }).__globalsOwner;
  if (found === undefined) {
    throw new Error(
      "the globals preload is not installed on the owner window. Pass preloadPath() as the " +
        "preload in webPreferences.",
    );
  }
  return found;
}

export type StartOwnerOptions<State> = OwnerRuntimeOptions<State>;

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

  api.onMainRequest((channel, request) => {
    try {
      if (channel === CHANNEL.OpenWindow) {
        const { url, name, features } = request.payload as {
          url: string;
          name: string;
          features?: string;
        };
        const opened = runtime.openWindow(url, name, features);
        api.reply(CHANNEL.OpenResult, { id: request.id, value: opened });
        return;
      }
      if (channel === CHANNEL.MainRead) {
        api.reply(CHANNEL.MainReply, { id: request.id, value: runtime.read() });
        return;
      }
      const { operation, payload } = request.payload as { operation: string; payload: unknown };
      api.reply(CHANNEL.MainReply, { id: request.id, value: runtime.apply(operation, payload) });
    } catch (error) {
      const reply = channel === CHANNEL.OpenWindow ? CHANNEL.OpenResult : CHANNEL.MainReply;
      api.reply(reply, {
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  return runtime;
}
