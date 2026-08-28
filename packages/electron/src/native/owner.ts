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

import { COMMIT, DISPATCH, HELLO, type DispatchMessage, type Hello } from "./channel.js";
import { createNativeOwner, type NativeOwner, type NativeOwnerOptions } from "./owner-core.js";

export type { NativeOperation, NativeOwner, NativeOwnerOptions } from "./owner-core.js";

export interface StartNativeOwnerOptions<State> extends Omit<NativeOwnerOptions<State>, "regionPath"> {
  /** Defaults to a file named globals.region under the app's userData directory. */
  regionPath?: string;
}

export function startNativeOwner<State>(options: StartNativeOwnerOptions<State>): NativeOwner<State> {
  const regionPath = options.regionPath ?? join(app.getPath("userData"), "globals.region");
  const owner = createNativeOwner({ ...options, regionPath });

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

  // The flush subscriber inside createNativeOwner registered first, so by the time this
  // runs the commit is already in the region and the ping cannot arrive ahead of the bytes.
  const unsubscribe = owner.store.subscribe(() => {
    const version = owner.version();
    for (const sender of subscribers) {
      if (!sender.isDestroyed()) sender.send(COMMIT, version);
    }
  });

  return {
    ...owner,
    close() {
      unsubscribe();
      ipcMain.removeHandler(HELLO);
      ipcMain.removeHandler(DISPATCH);
      subscribers.clear();
      owner.close();
    },
  };
}
