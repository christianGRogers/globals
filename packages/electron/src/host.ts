import { app, BrowserWindow, ipcMain } from "electron";
import type { BrowserWindowConstructorOptions, WebContents } from "electron";

import { CHANNEL } from "./messages.js";
import { DEFAULT_SCHEME, pageUrl, registerScheme, serveScheme } from "./protocol.js";
import { SnapshotStore, type PersistenceOptions } from "./persistence.js";
import { preloadPath } from "./preload-path.js";

/**
 * The main process side.
 *
 * The host is a broker and nothing more. It creates the hidden owner window, asks the owner
 * to open the windows that need shared state, and stays entirely off the read path. The
 * buffer never passes through Node, which is the reason the topology works.
 *
 * Main process reads are asynchronous, because Node cannot map the arena. That inverts the
 * usual Electron mental model and the types say so at the call site rather than in a
 * paragraph nobody reads.
 */

export interface HostOptions {
  /** Directory served over the custom scheme. Must contain everything the pages import. */
  root: string;
  /** The page loaded into the hidden owner window, relative to the root. */
  ownerPage: string;
  /** Scheme name. Defaults to globals-app. */
  scheme?: string;
  /** Forward requests to a dev server instead of the filesystem, re-headed for isolation. */
  devServer?: string;
  /** Persist the owner state, with the temp file and rename discipline. */
  persistence?: PersistenceOptions;
  /** Applied to every window the owner opens. The main process still owns these decisions. */
  windowOptions?: BrowserWindowConstructorOptions;
  /** Called when a window has been opened and is about to load. */
  onWindowOpened?: (window: BrowserWindow, name: string) => void;
  /**
   * Console output and preload failures from the owner window.
   *
   * The owner is hidden, so anything it logs is invisible by default, and a page that throws
   * during startup is silent from the main process. Wiring this before the page loads is the
   * difference between a diagnosable failure and a timeout with no explanation.
   */
  onOwnerMessage?: (line: string) => void;
}

export interface OpenWindowOptions {
  /** The page to load, relative to the served root. */
  page: string;
  /** A name the owner sees, and which decides the tier. Must be unique per window. */
  name: string;
  /** Overrides for this window only. */
  browserWindow?: BrowserWindowConstructorOptions;
}

/**
 * Register the custom scheme as privileged.
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
  readonly #openedByName = new Map<string, BrowserWindow>();
  #owner: BrowserWindow | undefined;
  #nextRequestId = 1;

  private constructor(options: HostOptions) {
    this.#options = options;
    this.#scheme = options.scheme ?? DEFAULT_SCHEME;
    this.#persistence =
      options.persistence === undefined ? undefined : new SnapshotStore(options.persistence);
  }

  /** Start the host. Call after the app is ready, and after prepare() ran at module scope. */
  static async start(options: HostOptions): Promise<GlobalsHost> {
    const host = new GlobalsHost(options);
    serveScheme({
      scheme: host.#scheme,
      root: options.root,
      ...(options.devServer === undefined ? {} : { devServer: options.devServer }),
    });
    await host.#createOwnerWindow();
    host.#wireQuit();
    return host;
  }

  get ownerWindow(): BrowserWindow | undefined {
    return this.#owner;
  }

  /** The window opened under a given name, if it is still open. */
  window(name: string): BrowserWindow | undefined {
    const found = this.#openedByName.get(name);
    return found?.isDestroyed() === false ? found : undefined;
  }

  /** The state loaded from disk, for the owner page to use as its initial value. */
  async restore(): Promise<{ value: unknown; version: number } | undefined> {
    return this.#persistence?.load();
  }

  /**
   * Open a window that will share the buffer.
   *
   * The owner opens it, not the main process, because a SharedArrayBuffer only crosses
   * between an opener and the window it opened. The main process still decides what the
   * window looks like, through windowOptions here and setWindowOpenHandler underneath.
   *
   * See docs/adr/0002-window-open-handshake.md for why it works this way.
   */
  async openWindow(options: OpenWindowOptions): Promise<BrowserWindow> {
    const owner = this.#requireOwner();

    const created = new Promise<BrowserWindow>((resolve, reject) => {
      const timer = setTimeout(() => {
        owner.webContents.off("did-create-window", onCreated);
        reject(new Error(`the owner did not open a window named ${options.name} in time`));
      }, 10_000);

      const onCreated = (window: BrowserWindow, details: { frameName: string }): void => {
        if (details.frameName !== options.name) return;
        clearTimeout(timer);
        owner.webContents.off("did-create-window", onCreated);
        this.#openedByName.set(options.name, window);
        window.on("closed", () => this.#openedByName.delete(options.name));
        this.#options.onWindowOpened?.(window, options.name);
        resolve(window);
      };

      owner.webContents.on("did-create-window", onCreated);
    });

    // Remembered so setWindowOpenHandler can apply the right options to this one.
    this.#pendingOptions.set(options.name, options.browserWindow ?? {});

    const opened = await this.#request(CHANNEL.OpenWindow, CHANNEL.OpenResult, {
      url: this.url(options.page),
      name: options.name,
    });

    if (opened !== true) {
      throw new Error(
        `the owner could not open a window named ${options.name}. Window opening may be ` +
          "blocked, which would leave every window on the asynchronous tier.",
      );
    }

    return created;
  }

  readonly #pendingOptions = new Map<string, BrowserWindowConstructorOptions>();

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
    return this.#request(CHANNEL.MainRead, CHANNEL.MainReply, undefined);
  }

  /** Ask the owner to apply a named operation. Resolves once the write is observable. */
  async dispatch(operation: string, payload?: unknown): Promise<number> {
    const result = await this.#request(CHANNEL.MainIntent, CHANNEL.MainReply, {
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
      webPreferences: {
        preload: preloadPath(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden window is throttled when the application is in the background, which
        // would stall commits. The owner renders nothing, so the throttle buys nothing and
        // costs correctness.
        backgroundThrottling: false,
      },
    });
    this.#owner = window;

    const report = this.#options.onOwnerMessage;
    if (report !== undefined) {
      window.webContents.on("console-message", (_event, _level, message, line, source) => {
        report(`${message} (${source}:${line})`);
      });
      window.webContents.on("preload-error", (_event, path, error) => {
        report(`preload failed: ${path}: ${error.message}`);
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        report(`the owner renderer is gone: ${details.reason}`);
      });
    }

    // Every window the owner opens is created here, so the main process keeps control of what
    // they look like even though it is no longer the one calling new BrowserWindow.
    window.webContents.setWindowOpenHandler(({ frameName }) => ({
      action: "allow",
      overrideBrowserWindowOptions: {
        show: true,
        width: 1024,
        height: 720,
        ...this.#options.windowOptions,
        ...this.#pendingOptions.get(frameName),
        webPreferences: {
          preload: preloadPath(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          ...this.#options.windowOptions?.webPreferences,
          ...this.#pendingOptions.get(frameName)?.webPreferences,
        },
      },
    }));

    const loaded = new Promise<void>((resolve, reject) => {
      window.webContents.once("did-finish-load", () => resolve());
      window.webContents.once("did-fail-load", (_event, code, description) => {
        reject(new Error(`the owner page failed to load: ${description} (${code})`));
      });
    });

    void window.loadURL(this.url(this.#options.ownerPage));
    await loaded;
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

  #requireOwner(): BrowserWindow {
    const owner = this.#owner;
    if (owner === undefined || owner.isDestroyed()) {
      throw new Error("the owner window is gone. Restart the host before reading or writing.");
    }
    return owner;
  }

  #request(channel: string, replyChannel: string, payload: unknown): Promise<unknown> {
    const owner = this.#requireOwner();
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const listener = (
        _event: unknown,
        reply: { id: number; value?: unknown; error?: { message: string } },
      ): void => {
        if (reply.id !== id) return;
        ipcMain.off(replyChannel, listener);
        clearTimeout(timer);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.value);
      };

      // A reply that never comes would leak a listener and a promise. The owner is a renderer
      // and can crash, so this is a real case rather than a defensive flourish.
      const timer = setTimeout(() => {
        ipcMain.off(replyChannel, listener);
        reject(new Error(`the owner did not answer ${channel} within ten seconds`));
      }, 10_000);
      timer.unref?.();

      ipcMain.on(replyChannel, listener);
      owner.webContents.send(channel, { id, payload });
    });
  }
}

export type { WebContents };
