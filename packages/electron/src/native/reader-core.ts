/**
 * The reading side over the native transport, with no Electron import. The preload glue in
 * ./renderer.js is a thin layer over this.
 *
 * The read path: one native version check per read; when the region moved, one
 * seqlock-consistent copy into a fresh private buffer, and the untouched core reader decodes
 * that. A read can never observe a stale version and never a torn one. A snapshot pins the
 * buffer it was taken from: superseded buffers stay alive exactly as long as something still
 * reads them, and ordinary garbage collection is the whole reclamation story. Nothing here
 * writes shared memory, and cross process epochs do not exist to manage.
 */
import { ReaderStore, type ReadableStore, type Snapshot } from "@bradensbay/globals-core";
import { ReaderRegion } from "@bradensbay/globals-shm";

export class NativeReaderSource implements ReadableStore {
  #region: ReaderRegion;
  #held = 0;
  #store: ReaderStore | null = null;
  #notified = 0;
  readonly #listeners = new Set<() => void>();

  private constructor(region: ReaderRegion) {
    this.#region = region;
  }

  static attach(regionPath: string): NativeReaderSource {
    return new NativeReaderSource(ReaderRegion.attach(regionPath));
  }

  /** The live region version, one native call. */
  get version(): number {
    return this.#region.version();
  }

  get(): unknown {
    return this.#ensure().get();
  }

  select(path: readonly (string | number)[]): unknown {
    return this.#ensure().select(path);
  }

  snapshot(): Snapshot {
    return this.#ensure().snapshot();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Tell the source a commit happened. The integration calls this off a notification
   * message; nothing on the read path depends on it, it only drives rerenders.
   */
  notify(): void {
    const version = this.#region.version();
    if (version === this.#notified) return;
    this.#notified = version;
    for (const listener of this.#listeners) listener();
  }

  close(): void {
    this.#region.close();
    this.#store = null;
    this.#listeners.clear();
  }

  #ensure(): ReaderStore {
    const version = this.#region.version();
    if (version === 0) {
      throw new Error("the region holds no commit yet: the owner has not flushed");
    }
    if (this.#store === null || version !== this.#held) {
      // A fresh private buffer per observed commit. The previous store is dropped, not
      // closed: snapshots taken from it keep their buffer alive until they are collected.
      //
      // A plain ArrayBuffer, deliberately. Blink hides the SharedArrayBuffer constructor
      // from a renderer that is not cross origin isolated, unsandboxed preloads included,
      // and nothing here needs sharing: the buffer is this process's private copy. Atomics
      // operate on non-shared buffers, and the read path never waits, so the core reader
      // works unchanged; only its declared type expects the shared flavour.
      const copy = new ArrayBuffer(this.#region.dataSize);
      this.#held = this.#region.sync(new Uint8Array(copy));
      this.#store = new ReaderStore(copy as unknown as SharedArrayBuffer);
    }
    return this.#store;
  }
}
