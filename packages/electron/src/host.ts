import { app, BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import type { WebContents } from "electron";
import { join } from "node:path";

import { CHANNEL } from "./messages.js";
import { DEFAULT_SCHEME, pageUrl, registerScheme, serveScheme } from "./protocol.js";
import { SnapshotStore, type PersistenceOptions } from "./persistence.js";
import { preloadPath } from "./preload-path.js";

/**
 * The main process side.
 *
 * The host is a broker and nothing more. It creates the hidden owner window, it hands one
 * end of a MessageChannel to the owner and the other to each window, and it stays entirely
 * off the read path. The buffer never passes through Node, which is the reason the topology
 * works at all.
 *
 * Main process reads are asynchronous, because Node cannot map the arena. That inverts the
 * usual Electron mental model and the types say so at the call site rather than in a
 * paragraph nobody reads.
 */

export interface HostOptions {
  /** Directory served over the custom scheme. */
  root: string;
  /** The page loaded into the hidden owner window, relative to the root. */
  ownerPage: string;
  /** Scheme name. Defaults to globals-app. */
  scheme?: string;
  /** Forward requests to a dev server instead of the filesystem, re-headed for isolation. */
  devServer?: string;
  /** Persist the owner state, with the temp file and rename discipline. */
  persistence?: PersistenceOptions;
  /** Called when a window is bound, so an application can log or count. */
  onWindowBound?: (webContents: WebContents, name: string) => void;
}

export interface AttachOptions {
  /**
   * A name the owner sees, so it can decide whether this window gets the shared tier.
   *
   * Give any window that renders content you do not control a name your owner recognises as
   * asynchronous only. See docs/trust-model.md.
   */
  name?: string;
}

/**
 * Registers the scheme as privileged.
 *
 * Must run at module scope in the main process, before the app is ready. Electron ignores a
 * registration made afterwards, and the symptom is a renderer that is quietly not cross
 * origin isolated, which surfaces much later as a buffer that will not transfer.
 */
export function prepare(scheme: string = DEFAULT_SCHEME): void {
  registerScheme(scheme);
}

export class GlobalsHost {
  readonly #options: HostOptions;
  readonly #scheme: string;
  readonly #persistence: SnapshotStore | undefined;
  readonly #bound = new Map<number, string>();
  #owner: BrowserWindow | undefined;
  #ownerReady: Promise<void> | undefined;

  private constructor(options: HostOptions) {
    this.#options = options;
    this.#scheme = options.scheme ?? DEFAULT_SCHEME;
    this.#persistence =
      options.persistence === undefined ? undefined : new SnapshotStore(options.persistence);
  }

  /**
   * Start the host. Call after the app is ready, and after `prepare()` ran at module scope.
   */
  static async start(options: HostOptions): Promise<GlobalsHost> {
    const host = new GlobalsHost(options);
    serveScheme({
      scheme: host.#scheme,
      root: options.root,
      ...(options.devServer === undefined ? {} : { devServer: options.devServer }),
    });
    await host.#createOwnerWindow();
    host.#wireBootstrap();
    host.#wireQuit();
    return host;
  }

  get ownerWindow(): BrowserWindow | undefined {
    return this.#owner;
  }

  /** The state loaded from disk, for the owner page to use as its initial value. */
  async restore(): Promise<{ value: unknown; version: number } | undefined> {
    return this.#persistence?.load();
  }

  /**
   * Attach a window.
   *
   * Call it before the window loads. The handshake completes during load, so the window has
   * its buffer before its first render rather than after, which is what lets a first paint
   * read real state instead of a placeholder.
   */
  attach(window: BrowserWindow, options: AttachOptions = {}): void {
    const name = options.name ?? `window-${window.id}`;
    this.#bound.set(window.webContents.id, name);

    const rebind = (): void => {
      // A reload discards the renderer heap and its port with it. The window asks again on
      // the bootstrap channel, and the reader slot it abandoned is reaped by the liveness
      // detector in the owner.
      void this.#handoff(window.webContents, name);
    };

    window.webContents.on("did-finish-load", rebind);
    window.on("closed", () => this.#bound.delete(window.webContents.id));
  }

  /** The page URL for a path under the served root. */
  url(page: string): string {
    return pageUrl(page, this.#scheme);
  }

  /**
   * Read the current state from the main process.
   *
   * Asynchronous, and it will stay asynchronous. Node cannot map the arena, so this is a
   * round trip to the owner window. Do not put it on a path that runs per frame.
   */
  async read(): Promise<unknown> {
    const owner = await this.#requireOwner();
    return this.#request(owner.webContents, CHANNEL.MainRead, undefined);
  }

  /**
   * Ask the owner to apply a named operation.
   *
   * Resolves once the write is committed and observable by every window.
   */
  async dispatch(operation: string, payload?: unknown): Promise<number> {
    const owner = await this.#requireOwner();
    const result = await this.#request(owner.webContents, CHANNEL.MainIntent, {
      operation,
      payload,
    });
    return result as number;
  }

  /** Write whatever is queued for persistence. Called on quit, and available to callers. */
  async flush(): Promise<void> {
    await this.#persistence?.flush();
  }

  /** Record a commit for persistence. The owner page calls this through the host bridge. */
  persist(value: unknown, version: number): void {
    this.#persistence?.save(value, version);
  }

  async #createOwnerWindow(): Promise<void> {
    const window = new BrowserWindow({
      show: false,
      // A hidden window is still throttled when the application is in the background, which
      // would stall commits. The owner is not rendering anything, so the throttle buys
      // nothing and costs correctness.
      webPreferences: {
        preload: preloadPath(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.#owner = window;

    this.#ownerReady = new Promise<void>((resolve, reject) => {
      window.webContents.once("did-finish-load", () => resolve());
      window.webContents.once("did-fail-load", (_event, code, description) => {
        reject(new Error(`the owner page failed to load: ${description} (${code})`));
      });
    });

    await window.loadURL(this.url(this.#options.ownerPage));
    await this.#ownerReady;
  }

  #wireBootstrap(): void {
    ipcMain.on(CHANNEL.Ready, (event) => {
      const name = this.#bound.get(event.sender.id);
      if (name === undefined) return;
      void this.#handoff(event.sender, name);
    });

    ipcMain.on(CHANNEL.Rebind, (event) => {
      const name = this.#bound.get(event.sender.id);
      if (name === undefined) return;
      void this.#handoff(event.sender, name);
    });
  }

  #wireQuit(): void {
    app.on("before-quit", (event) => {
      const pending = this.#persistence;
      if (pending === undefined) return;
      // Quitting with a debounced write outstanding would lose the last commit, which is
      // exactly the commit a user is most likely to notice missing.
      event.preventDefault();
      void pending.flush().finally(() => app.exit(0));
    });
  }

  async #handoff(target: WebContents, name: string): Promise<void> {
    const owner = await this.#requireOwner();
    if (target.isDestroyed()) return;

    const { port1, port2 } = new MessageChannelMain();
    owner.webContents.postMessage(CHANNEL.Port, { name }, [port1]);
    target.postMessage(CHANNEL.Port, { name }, [port2]);
    this.#options.onWindowBound?.(target, name);
  }

  async #requireOwner(): Promise<BrowserWindow> {
    const owner = this.#owner;
    if (owner === undefined || owner.isDestroyed()) {
      throw new Error("the owner window is gone. Restart the host before reading or writing.");
    }
    await this.#ownerReady;
    return owner;
  }

  #nextRequestId = 1;

  #request(target: WebContents, channel: string, payload: unknown): Promise<unknown> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const listener = (
        _event: unknown,
        reply: { id: number; value?: unknown; error?: { message: string } },
      ): void => {
        if (reply.id !== id) return;
        ipcMain.off(CHANNEL.MainReply, listener);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.value);
      };
      ipcMain.on(CHANNEL.MainReply, listener);
      target.send(channel, { id, payload });

      // A reply that never comes would leak a listener and a promise. The owner is a
      // renderer and can crash, so this is a real case rather than a defensive flourish.
      setTimeout(() => {
        ipcMain.off(CHANNEL.MainReply, listener);
        reject(new Error(`the owner did not answer ${channel} within ten seconds`));
      }, 10_000).unref?.();
    });
  }
}

export { join };
