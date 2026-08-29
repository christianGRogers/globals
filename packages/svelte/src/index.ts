import { sameNode, type ReadableStore, type Snapshot } from "@bradensbay/globals-core";

/**
 * The Svelte adapter.
 *
 * Svelte's store contract is one method: `subscribe(run)` returns an unsubscribe function
 * and calls `run` immediately with the current value. That maps onto this library exactly,
 * so the adapter is a few lines and needs no framework import at all, which also means it
 * works with Svelte 4 and 5 without a version specific build.
 */

export interface Readable<T> {
  subscribe(run: (value: T) => void, invalidate?: () => void): () => void;
}

/**
 * The whole state as a Svelte readable.
 *
 * `$state` in a component rereads on every commit. For a large state shape prefer `selected`
 * or `path`, which only notify when the slice they watch actually changes.
 */
export function globalState<T = unknown>(store: ReadableStore): Readable<T> {
  return {
    subscribe(run) {
      run(store.get() as T);
      return store.subscribe(() => run(store.get() as T));
    },
  };
}

/**
 * A readable over a slice.
 *
 * Notifies when the selected value changes, compared with `equals`.
 *
 * The default is `Object.is`, which is right for a scalar and wrong for a container: each
 * commit builds a fresh decode cache, so a selector returning a nested object returns a new
 * proxy every time and notifies on every commit even when nothing it selected changed. For a
 * container, pass `sameNode`, which compares the arena node behind the value and therefore
 * answers the question the selector is actually asking.
 */
export function selected<T>(
  store: ReadableStore,
  selector: (state: unknown) => T,
  equals: (a: T, b: T) => boolean = Object.is,
): Readable<T> {
  return {
    subscribe(run) {
      let previous = selector(store.get());
      run(previous);
      return store.subscribe(() => {
        const next = selector(store.get());
        if (equals(next, previous)) return;
        previous = next;
        run(next);
      });
    },
  };
}

/** A readable over a container slice, compared by the arena node behind it. */
export function selectedNode<T>(
  store: ReadableStore,
  selector: (state: unknown) => T,
): Readable<T> {
  return selected(store, selector, sameNode as (a: T, b: T) => boolean);
}

/** A readable over one path, which walks the arena without building intermediate views. */
export function path<T = unknown>(
  store: ReadableStore,
  steps: readonly (string | number)[],
): Readable<T> {
  return selected(store, () => store.select(steps) as T);
}

/**
 * A readable holding a pinned snapshot.
 *
 * The previous pin is released when a new version arrives and the last one when the final
 * subscriber leaves, so a component using this does not have to remember to release
 * anything. Holding one still blocks reclamation while it is held.
 */
export function pinnedSnapshot(store: ReadableStore): Readable<Snapshot> {
  return {
    subscribe(run) {
      let held: Snapshot | undefined = store.snapshot();
      run(held);

      const unsubscribe = store.subscribe(() => {
        const next = store.snapshot();
        if (next === held) return;
        held?.release();
        held = next;
        run(next);
      });

      return () => {
        unsubscribe();
        held?.release();
        held = undefined;
      };
    },
  };
}

/**
 * The version counter as a readable.
 *
 * For a component that reacts to commits without reading anything, which otherwise has no
 * dependency to declare.
 */
export function version(store: ReadableStore): Readable<number> {
  return {
    subscribe(run) {
      run(store.version);
      return store.subscribe(() => run(store.version));
    },
  };
}

export type { ReadableStore, Snapshot };
