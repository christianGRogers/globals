/**
 * The owner over the native transport, with no Electron import so it is testable in plain
 * Node. The Electron glue in ./owner.js is a thin layer over this.
 *
 * The owner is the ordinary core OwnerStore writing a private SharedArrayBuffer, exactly as
 * the worker-thread topology uses it. What this module adds is publication: after every
 * commit, the arena bytes are flushed into the mapped region under the region's seqlock, so
 * any process that syncs the region gets a consistent copy of a committed arena and decodes
 * it with the untouched core reader.
 *
 * Growth is deliberately disabled: the region's size is fixed at creation, so the arena is
 * created with maxByteLength equal to byteLength and a full arena raises ArenaFullError
 * rather than growing past what readers mapped. A growable region is future work with a
 * re-handshake, not a default.
 */
import { OwnerStore, type OwnerOptions } from "@globals/core";
import { OwnerRegion } from "@globals/shm";

import { SnapshotStore, type PersistenceOptions } from "../persistence.js";

/** A named write the owner is willing to apply. Everything a window may do is one of these. */
export type NativeOperation<State, Payload = unknown> = (draft: State, payload: Payload) => void;

export interface NativeOwnerOptions<State> {
  /** Where the region file lives. Every window that connects maps this path. */
  regionPath: string;
  /** The state the store holds before the first operation. */
  initial: State;
  /** The writes windows may request, by name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operations?: Record<string, NativeOperation<State, any>>;
  /** Arena and region size in bytes. Fixed for the life of the region. */
  byteLength?: number;
  /** Core arena options other than size, passed through. */
  arena?: Omit<OwnerOptions, "byteLength" | "maxByteLength">;
  /** An already constructed snapshot store to save every commit into. */
  snapshots?: SnapshotStore;
}

export interface NativeOwner<State> {
  /** The core store, for reads, subscriptions, and direct writes from the owning process. */
  readonly store: OwnerStore;
  readonly regionPath: string;
  /** The snapshot store saving commits, when persistence is configured. */
  readonly snapshots: SnapshotStore | undefined;
  /** The region version: the number of commits flushed. */
  version(): number;
  /** Apply a named operation, the same call a window's dispatch arrives as. */
  dispatch(operation: string, payload: unknown): Promise<number>;
  /** A typed direct write from the owning process, without naming an operation. */
  update(recipe: (draft: State) => void): Promise<number>;
  close(): void;
}

const DEFAULT_BYTE_LENGTH = 1 << 20;

export function createNativeOwner<State>(options: NativeOwnerOptions<State>): NativeOwner<State> {
  const byteLength = options.byteLength ?? DEFAULT_BYTE_LENGTH;
  const operations = options.operations ?? {};
  const store = OwnerStore.create(options.initial, {
    ...options.arena,
    byteLength,
    maxByteLength: byteLength,
  });
  const region = OwnerRegion.create(options.regionPath, store.buffer.byteLength);

  // Whole-buffer flush per commit. The bump allocator makes dirty ranges cheap to compute
  // and they are the planned refinement, but a megabyte costs about sixteen microseconds to
  // publish, so correctness ships first.
  const flush = (): number => region.flush(new Uint8Array(store.buffer));

  // OwnerStore.create committed the initial state before anyone could subscribe.
  flush();
  const snapshots = options.snapshots;
  const unsubscribe = store.subscribe(() => {
    flush();
    // The flush above published the bytes; this queues the debounced durable copy, which
    // must never sit on the commit path.
    snapshots?.save(store.snapshot().toJSON(), store.version);
  });

  return {
    store,
    regionPath: options.regionPath,
    snapshots,
    version: () => region.version(),
    dispatch(operation, payload) {
      const apply = operations[operation];
      if (apply === undefined) {
        return Promise.reject(
          new Error(
            `unknown operation "${operation}". The owner declares: ${Object.keys(operations).join(", ") || "none"}`,
          ),
        );
      }
      return store.update<State>((draft) => apply(draft, payload));
    },
    update(recipe) {
      return store.update<State>(recipe);
    },
    close() {
      unsubscribe();
      void snapshots?.flush();
      store.close();
      region.close();
    },
  };
}

/**
 * Create the owner with persistence: rehydrate the last saved snapshot if one exists, use
 * the configured initial state otherwise, and save every commit from then on. Asynchronous
 * because rehydration reads a file, and startup is the one place that wait belongs.
 */
export async function restoreNativeOwner<State>(
  options: NativeOwnerOptions<State> & { persistence: PersistenceOptions },
): Promise<NativeOwner<State>> {
  const snapshots = new SnapshotStore(options.persistence);
  const loaded = await snapshots.load();
  return createNativeOwner({
    ...options,
    initial: (loaded?.value ?? options.initial) as State,
    snapshots,
  });
}
