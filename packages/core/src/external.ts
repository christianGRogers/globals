import { ExternalRef } from "./values.js";

/**
 * The escape hatch.
 *
 * Some values cannot go in shared memory: a class instance whose prototype carries
 * behaviour, a value keyed on object identity, a blob too large to be worth copying into the
 * arena. The plan calls for those to reach an asynchronous replicated tier through a visibly
 * different API, so the boundary between synchronous and asynchronous is legible in the
 * calling code rather than a runtime surprise.
 *
 * That is what this is. A value stored here is reachable through a promise and nothing else.
 * There is no accessor that looks synchronous, because the whole point is that you can see
 * from the call site which tier you are on.
 *
 *     const handle = tier.put(bigThing);
 *     store.update((draft) => { draft.attachment = handle; });
 *
 *     // In any process, later:
 *     const value = await tier.get(snapshot.attachment);
 *
 * The handle that lands in shared state is an integer. The value itself lives on the owner
 * heap and is replicated to readers by whatever transport the integration supplies, which in
 * Electron is ordinary asynchronous IPC.
 */
export interface ExternalTransport {
  /** Ask the owner for the value behind a handle. */
  fetch(handle: number): Promise<unknown>;
}

export class ExternalTier {
  #nextHandle = 1;
  readonly #owned = new Map<number, unknown>();
  readonly #transport: ExternalTransport | undefined;
  readonly #cache = new Map<number, Promise<unknown>>();

  /**
   * @param transport How a reader fetches a value it does not own. Omitted in the owner,
   * which holds every value itself.
   */
  constructor(transport?: ExternalTransport) {
    this.#transport = transport;
  }

  /** Owner side. Store a value and get a handle that can go into shared state. */
  put(value: unknown): ExternalRef {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#owned.set(handle, value);
    return new ExternalRef(handle);
  }

  /** Owner side. Drop a value. Reading its handle afterwards rejects. */
  drop(reference: ExternalRef | number): boolean {
    const handle = typeof reference === "number" ? reference : reference.handle;
    this.#cache.delete(handle);
    return this.#owned.delete(handle);
  }

  /**
   * Read a value. Asynchronous in every process, including the owner, so that moving code
   * between the owner and a window does not change whether it compiles.
   */
  async get(reference: ExternalRef | number): Promise<unknown> {
    const handle = typeof reference === "number" ? reference : reference.handle;

    if (this.#owned.has(handle)) return this.#owned.get(handle);

    const pending = this.#cache.get(handle);
    if (pending !== undefined) return pending;

    if (this.#transport === undefined) {
      throw new Error(
        `external handle ${handle} is not held here and no transport was supplied. In a ` +
          "reader, construct the tier with the transport the integration provides.",
      );
    }

    const request = this.#transport.fetch(handle);
    this.#cache.set(handle, request);
    try {
      return await request;
    } catch (error) {
      this.#cache.delete(handle);
      throw error;
    }
  }

  /** Owner side. Serve a fetch from another process. */
  serve(handle: number): unknown {
    if (!this.#owned.has(handle)) {
      throw new Error(`external handle ${handle} is not held by this owner`);
    }
    return this.#owned.get(handle);
  }

  /** Forget every cached replica. Called when the owner generation changes. */
  invalidate(): void {
    this.#cache.clear();
  }

  get size(): number {
    return this.#owned.size;
  }
}

export { ExternalRef };
