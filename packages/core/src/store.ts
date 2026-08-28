import { ArenaOwner, type OwnerOptions, type OwnerStats } from "./owner.js";
import { ArenaReader, type ReaderOptions, type Snapshot } from "./reader.js";

/**
 * The pair of interfaces the framework bindings and the Electron integration are written
 * against.
 *
 * Splitting reading from writing in the type system is the point. A window holds a
 * `ReadableStore`, which has no way to write, and the owner holds a `WritableStore`. Code
 * that wants to write has to say so, and the asynchrony is in the return type where the
 * caller can see it.
 */

export interface ReadableStore {
  /** The current committed value, synchronously. No await, no round trip. */
  get(): unknown;
  /** Read one path without materialising the nodes along it. */
  select(path: readonly (string | number)[]): unknown;
  /** Pin the current version. Release it when you are finished, or hold it for a render. */
  snapshot(): Snapshot;
  /** Called after every commit. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** The version currently published. */
  readonly version: number;
}

export interface WritableStore extends ReadableStore {
  /**
   * Apply a recipe to a draft and commit the result.
   *
   * The promise resolves once the write is committed and observable. Reading before it
   * resolves may return the old value, which is the contract rather than a defect.
   */
  update<T>(recipe: (draft: T) => void): Promise<number>;
  /** Replace the root outright. Asynchronous for the same reason update is. */
  set(value: unknown): Promise<number>;
}

/**
 * The owner side store.
 *
 * Writes are queued and applied in order, and the promise resolves after the commit is
 * published. Queuing rather than applying inline means a recipe cannot observe a half
 * applied earlier write, and it makes the total order the contract promises explicit rather
 * than incidental.
 */
export class OwnerStore implements WritableStore {
  readonly owner: ArenaOwner;
  readonly #listeners = new Set<() => void>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(owner: ArenaOwner) {
    this.owner = owner;
  }

  static create(initial: unknown, options: OwnerOptions = {}): OwnerStore {
    const owner = ArenaOwner.create(options);
    owner.commit(initial);
    return new OwnerStore(owner);
  }

  get buffer(): SharedArrayBuffer {
    return this.owner.buffer;
  }

  get version(): number {
    return this.owner.versionId;
  }

  get(): unknown {
    return this.snapshot().value;
  }

  select(path: readonly (string | number)[]): unknown {
    return this.snapshot().get(path);
  }

  snapshot(): Snapshot {
    return this.#reader().acquire();
  }

  #ownReader: ArenaReader | undefined;

  #reader(): ArenaReader {
    if (this.#ownReader === undefined) {
      // The owner reads through an ordinary reader, on the same code path every window uses.
      // A separate owner only read path would be a second implementation to keep correct.
      this.#ownReader = ArenaReader.attach(this.owner.buffer);
    }
    return this.#ownReader;
  }

  update<T>(recipe: (draft: T) => void): Promise<number> {
    return this.#enqueue(() => this.owner.update(recipe));
  }

  set(value: unknown): Promise<number> {
    return this.#enqueue(() => this.owner.commit(value));
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #enqueue(work: () => number): Promise<number> {
    const result = this.#queue.then(() => {
      const version = work();
      this.#notify();
      return version;
    });
    // Keep the chain alive after a rejection, or one failed write would stall every later
    // one behind it.
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  close(): void {
    this.#ownReader?.detach();
    this.#ownReader = undefined;
    this.#listeners.clear();
  }
}

/**
 * The reader side store.
 *
 * It has no write method at all. A window that needs to write does it through the intent
 * channel the integration supplies, which is asynchronous by construction.
 */
export class ReaderStore implements ReadableStore {
  readonly reader: ArenaReader;
  readonly #listeners = new Set<() => void>();
  #lastSeen: number;

  constructor(buffer: SharedArrayBuffer, options: ReaderOptions = {}) {
    this.reader = ArenaReader.attach(buffer, options);
    this.#lastSeen = this.reader.publishedVersion();
  }

  get version(): number {
    return this.reader.publishedVersion();
  }

  get(): unknown {
    return this.reader.acquire().value;
  }

  select(path: readonly (string | number)[]): unknown {
    return this.reader.acquire().get(path);
  }

  snapshot(): Snapshot {
    return this.reader.acquire();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Tell the store a commit happened.
   *
   * The integration calls this when the owner notifies it. Deliberately not a poll: nothing
   * on the read path may depend on a message arriving, so this only drives rerenders.
   */
  notify(): void {
    const version = this.reader.publishedVersion();
    if (version === this.#lastSeen) return;
    this.#lastSeen = version;
    for (const listener of this.#listeners) listener();
  }

  close(): void {
    this.reader.detach();
    this.#listeners.clear();
  }
}

export type { OwnerStats, Snapshot };
