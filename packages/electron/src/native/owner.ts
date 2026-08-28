/**
 * The Electron glue for the native owner: main process only.
 *
 * The owner is a plain object in the main process. There is no hidden window, no privileged
 * scheme, no isolation headers, and no handshake that hands a buffer to anyone: windows map
 * the region file themselves from their preloads, and everything the main process owes them
 * is the region's path and a content-free ping per commit.
 */
import { app, ipcMain } from "electron";
import type { WebContents } from "electron";
import { join } from "node:path";

import type { PersistenceOptions } from "../persistence.js";
import { COMMIT, DISPATCH, HELLO, READ, type DispatchMessage, type Hello } from "./channel.js";
import {
  createNativeOwner,
  restoreNativeOwner,
  type NativeOwner,
  type NativeOwnerOptions,
} from "./owner-core.js";

export type { NativeOperation, NativeOwner, NativeOwnerOptions } from "./owner-core.js";
export { asyncPreloadPath } from "./paths.js";

export interface StartNativeOwnerOptions<State>
  extends Omit<NativeOwnerOptions<State>, "regionPath" | "snapshots"> {
  /** Defaults to a file named globals.region under the app's userData directory. */
  regionPath?: string;
  /**
   * Persist commits and rehydrate on start. The file defaults to globals.snapshot.json
   * under the app's userData directory.
   */
  persistence?: Omit<PersistenceOptions, "file"> & { file?: string };
}

function materialise(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export async function startNativeOwner<State>(
  options: StartNativeOwnerOptions<State>,
): Promise<NativeOwner<State>> {
  const regionPath = options.regionPath ?? join(app.getPath("userData"), "globals.region");
  const owner = options.persistence
    ? await restoreNativeOwner({
        ...options,
        regionPath,
        persistence: {
          file: join(app.getPath("userData"), "globals.snapshot.json"),
          ...options.persistence,
        },
      })
    : createNativeOwner({ ...options, regionPath });

  const subscribers = new Set<WebContents>();
  ipcMain.handle(HELLO, (event): Hello => {
    const sender = event.sender;
    if (!subscribers.has(sender)) {
      subscribers.add(sender);
      sender.once("destroyed", () => subscribers.delete(sender));
    }
    return { regionPath, version: owner.version() };
  });
  ipcMain.handle(DISPATCH, (_event, message: DispatchMessage) =>
    owner.dispatch(message.operation, message.payload),
  );
  // The asynchronous tier. The lazy view is a Proxy and structured clone refuses proxies,
  // so what crosses the wire is materialised first. This path is for windows that keep
  // their sandbox; it reads by request and pays a round trip, which is the documented trade.
  ipcMain.handle(READ, (_event, message?: { path?: readonly (string | number)[] }) => {
    const value =
      message?.path === undefined
        ? owner.store.snapshot().toJSON()
        : materialise(owner.store.select(message.path));
    return { version: owner.version(), value };
  });

  // The flush subscriber inside createNativeOwner registered first, so by the time this
  // runs the commit is already in the region and the ping cannot arrive ahead of the bytes.
  const unsubscribe = owner.store.subscribe(() => {
    const version = owner.version();
    for (const sender of subscribers) {
      if (!sender.isDestroyed()) sender.send(COMMIT, version);
    }
  });

  // A debounced snapshot that never gets its final write is a stale rehydrate next boot.
  const onQuit = (): void => {
    void owner.snapshots?.flush();
  };
  if (owner.snapshots) app.on("before-quit", onQuit);

  return {
    ...owner,
    close() {
      unsubscribe();
      app.removeListener("before-quit", onQuit);
      ipcMain.removeHandler(HELLO);
      ipcMain.removeHandler(DISPATCH);
      ipcMain.removeHandler(READ);
      subscribers.clear();
      owner.close();
    },
  };
}
