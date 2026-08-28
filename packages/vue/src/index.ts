import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  triggerRef,
  type App,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef,
} from "vue";
import { sameNode, type ReadableStore, type Snapshot } from "@globals/core";

/**
 * The Vue adapter.
 *
 * Thin over the same subscribe and snapshot pair the React binding uses. Vue reactivity wants
 * a ref that changes identity when the underlying data changes, and a version counter is
 * exactly that: it moves on every commit and on nothing else.
 *
 * `shallowRef` rather than `ref` on purpose. Deep reactivity would walk the state proxy and
 * decode every property to install tracking, which is the opposite of what a lazy view is
 * for.
 */

const STORE: InjectionKey<ReadableStore> = Symbol("globals.store");

export function provideStore(store: ReadableStore): void {
  provide(STORE, store);
}

/** Register the store application wide, for a root that has no component to provide from. */
export function installStore(app: App, store: ReadableStore): void {
  app.provide(STORE, store);
}

export function useStore(): ReadableStore {
  const store = inject(STORE);
  if (store === undefined) {
    throw new Error("no globals store is provided. Call provideStore or installStore first.");
  }
  return store;
}

/**
 * A ref holding the current version.
 *
 * Everything else is derived from this. Exposed because a component that wants to react to
 * commits without reading anything, such as one that only renders a timestamp, has no other
 * dependency to declare.
 */
export function useVersion(store: ReadableStore = useStore()): ShallowRef<number> {
  const version = shallowRef(store.version);
  const unsubscribe = store.subscribe(() => {
    version.value = store.version;
    // The version is a number and may repeat after an owner restart, so a nudge keeps
    // dependents correct without relying on the value having changed.
    triggerRef(version);
  });
  onScopeDispose(unsubscribe);
  return version;
}

/**
 * A computed over a slice of state.
 *
 * The selector runs when the version changes and not otherwise, so it can be as cheap or as
 * expensive as the slice deserves. Vue compares the computed result before it wakes
 * dependents, so a scalar slice behaves the way you would expect.
 *
 * A container slice does not: every commit builds a fresh decode cache, so the view is a new
 * proxy each time. Use useNodeSelector for those.
 */
export function useSelector<T>(
  selector: (state: unknown) => T,
  store: ReadableStore = useStore(),
): ComputedRef<T> {
  const version = useVersion(store);
  return computed(() => {
    void version.value;
    return selector(store.get());
  });
}

/**
 * A computed over a container slice, compared by the arena node behind it.
 *
 * Holds the previous value and returns it unchanged when the node did not move, so
 * dependents see a stable reference across commits that did not touch the subtree.
 */
export function useNodeSelector<T>(
  selector: (state: unknown) => T,
  store: ReadableStore = useStore(),
): ComputedRef<T> {
  const version = useVersion(store);
  let held: { value: T } | undefined;

  return computed(() => {
    void version.value;
    const next = selector(store.get());
    if (held !== undefined && sameNode(held.value, next)) return held.value;
    held = { value: next };
    return next;
  });
}

/** A computed over one path, which walks the arena without building intermediate views. */
export function usePath<T = unknown>(
  path: readonly (string | number)[],
  store: ReadableStore = useStore(),
): ComputedRef<T> {
  const version = useVersion(store);
  return computed(() => {
    void version.value;
    return store.select(path) as T;
  });
}

/** The whole state, recomputed on every commit. */
export function useGlobalState<T = unknown>(
  store: ReadableStore = useStore(),
): ComputedRef<T> {
  const version = useVersion(store);
  return computed(() => {
    void version.value;
    return store.get() as T;
  });
}

/**
 * A pinned snapshot, released when the scope is disposed.
 *
 * Holding one blocks reclamation of that version, so a component that pins and then never
 * updates is eventually force advanced and sees StaleSnapshotError. That is bounded
 * retention working rather than a defect.
 */
export function usePinnedSnapshot(store: ReadableStore = useStore()): ComputedRef<Snapshot> {
  const version = useVersion(store);
  let held: Snapshot | undefined;

  const snapshot = computed(() => {
    void version.value;
    held?.release();
    held = store.snapshot();
    return held;
  });

  onScopeDispose(() => {
    held?.release();
    held = undefined;
  });

  return snapshot;
}

export type { ReadableStore, Snapshot };
