/**
 * The preload side of the native transport.
 *
 * This module runs in a preload with sandbox: false and context isolation on: a Node
 * context that can load the addon, in a window whose page cannot. The decode layer lives
 * here on purpose, because every contextBridge crossing costs about a microsecond; expose
 * whole operations to the page, not per-property reads.
 */
import { ipcRenderer } from "electron";

import type { ReadableStore, Snapshot } from "@globals/core";
import { COMMIT, DISPATCH, HELLO, type Hello } from "./channel.js";
import { NativeReaderSource } from "./reader-core.js";

export type { NativeReaderSource } from "./reader-core.js";

export interface NativeConnection extends ReadableStore {
  /** Ask the owner to apply a named operation. Resolves with the committed version. */
  dispatch(operation: string, payload?: unknown): Promise<number>;
  close(): void;
}

export async function connectNative(): Promise<NativeConnection> {
  const hello = (await ipcRenderer.invoke(HELLO)) as Hello;
  const source = NativeReaderSource.attach(hello.regionPath);
  const onCommit = (): void => source.notify();
  ipcRenderer.on(COMMIT, onCommit);

  return {
    get: () => source.get(),
    select: (path) => source.select(path),
    snapshot: (): Snapshot => source.snapshot(),
    subscribe: (listener) => source.subscribe(listener),
    get version() {
      return source.version;
    },
    dispatch: (operation, payload) =>
      ipcRenderer.invoke(DISPATCH, { operation, payload }) as Promise<number>,
    close() {
      ipcRenderer.removeListener(COMMIT, onCommit);
      source.close();
    },
  };
}
