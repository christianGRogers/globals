import type { SharedArena } from "./arena.js";
import { Tag } from "./tags.js";
import { ArenaCorruptError } from "./errors.js";
import { decodeString } from "./strings.js";
import { decodeValue, type Slot } from "./values.js";
import { hamtEntries, hamtGet, hamtGetString, keyHash } from "./hamt.js";
import { vectorGet, vectorLength, vectorSlots } from "./vector.js";
import { hashString } from "./checksum.js";

/**
 * Lazy views over arena data.
 *
 * `getSnapshot()` hands back one of these rather than a materialised object. Reading one
 * property decodes one property. A table that renders twenty visible rows out of five
 * thousand pays for twenty.
 *
 * Two things make the laziness safe rather than a trap:
 *
 *   Every property access revalidates the version. A view whose version was reclaimed raises
 *   StaleSnapshotError on the next access rather than returning stale bytes.
 *
 *   Decoded nodes are memoised per version. The cache is owned by the view context and is
 *   discarded wholesale when the root moves, so a stale entry is not reachable.
 */

export interface ViewContext {
  readonly arena: SharedArena;
  /** Throws when the version this view belongs to is no longer retained. */
  readonly validate: () => void;
  /** Decoded containers, keyed by arena offset, valid for one version only. */
  readonly cache: Map<number, unknown>;
}

const VIEW_SLOT = Symbol("globals.viewSlot");

/** True when the value is a lazy view rather than a plain decoded value. */
export function isView(value: unknown): boolean {
  return (
    value !== null && typeof value === "object" && (value as Record<symbol, unknown>)[VIEW_SLOT] !== undefined
  );
}

/** The slot a view is bound to, for callers that need the underlying reference. */
export function viewSlot(value: unknown): Slot | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<symbol, Slot | undefined>)[VIEW_SLOT];
}

/**
 * Decode a slot into a value, lazily for containers and eagerly for everything else.
 *
 * Scalars are cheaper to decode than to wrap, and a `Date` or a typed array has no useful
 * lazy form, so only objects, arrays, maps, and sets become views.
 */
export function viewValue(context: ViewContext, slot: Slot): unknown {
  switch (slot.tag) {
    case Tag.Object:
      return objectView(context, slot);
    case Tag.Array:
      return arrayView(context, slot);
    case Tag.Map:
      return mapView(context, slot);
    case Tag.Set:
      return setView(context, slot);
    default:
      return decodeValue(context.arena, slot);
  }
}

function cached<T>(context: ViewContext, offset: number, build: () => T): T {
  const existing = context.cache.get(offset);
  if (existing !== undefined) return existing as T;
  const created = build();
  context.cache.set(offset, created);
  return created;
}

function objectView(context: ViewContext, slot: Slot): Record<string, unknown> {
  return cached(context, slot.payload, () => {
    const node = slot.payload;
    let keys: string[] | undefined;

    const listKeys = (): string[] => {
      if (keys === undefined) {
        keys = hamtEntries(context.arena, node).map((entry) => {
          if (entry.key.tag !== Tag.String) {
            throw new ArenaCorruptError("object key is not a string", { actual: entry.key.tag });
          }
          return decodeString(context.arena, entry.key.payload);
        });
      }
      return keys;
    };

    // Interning is a write, so a reader cannot compare keys by offset the way the writer
    // does. It walks the trie by hash instead and compares characters only against the one
    // record it lands on, which keeps the lookup logarithmic.
    const lookup = (property: string): Slot | undefined =>
      hamtGetString(context.arena, node, property, hashString(property));

    return new Proxy({} as Record<string, unknown>, {
      get(_target, property) {
        if (property === VIEW_SLOT) return slot;
        if (property === "toJSON") {
          return () => decodeValue(context.arena, slot);
        }
        if (typeof property === "symbol") return undefined;
        context.validate();
        const found = lookup(property);
        return found === undefined ? undefined : viewValue(context, found);
      },
      has(_target, property) {
        if (typeof property === "symbol") return false;
        context.validate();
        return lookup(property) !== undefined;
      },
      ownKeys() {
        context.validate();
        return listKeys();
      },
      getOwnPropertyDescriptor(_target, property) {
        if (typeof property === "symbol") return undefined;
        context.validate();
        const found = lookup(property);
        if (found === undefined) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: viewValue(context, found),
        };
      },
      set() {
        throw new TypeError(
          "a snapshot is read only. Send a write through the owner instead, and remember it " +
            "is asynchronous.",
        );
      },
      deleteProperty() {
        throw new TypeError("a snapshot is read only");
      },
    });
  });
}

function arrayView(context: ViewContext, slot: Slot): unknown[] {
  return cached(context, slot.payload, () => {
    const vector = slot.payload;

    return new Proxy([] as unknown[], {
      get(_target, property) {
        if (property === VIEW_SLOT) return slot;
        if (property === "length") {
          context.validate();
          return vectorLength(context.arena, vector);
        }
        if (property === "toJSON") {
          return () => decodeValue(context.arena, slot);
        }
        if (typeof property === "symbol") {
          if (property !== Symbol.iterator) return undefined;
          return function* iterate(): Generator<unknown> {
            context.validate();
            const length = vectorLength(context.arena, vector);
            for (let i = 0; i < length; i += 1) {
              const element = vectorGet(context.arena, vector, i);
              yield element === undefined ? undefined : viewValue(context, element);
            }
          };
        }

        if (/^\d+$/.test(property)) {
          context.validate();
          const element = vectorGet(context.arena, vector, Number(property));
          return element === undefined ? undefined : viewValue(context, element);
        }

        // Array.prototype methods operate on the materialised array. Reimplementing them
        // lazily would mean reimplementing the array protocol, and the differences would be
        // found by users rather than by tests.
        context.validate();
        const materialised = vectorSlots(context.arena, vector).map((element) =>
          viewValue(context, element),
        );
        const value = (materialised as unknown as Record<string, unknown>)[property];
        return typeof value === "function" ? value.bind(materialised) : value;
      },
      has(_target, property) {
        if (property === "length") return true;
        if (typeof property === "symbol") return false;
        if (!/^\d+$/.test(property)) return false;
        context.validate();
        return Number(property) < vectorLength(context.arena, vector);
      },
      ownKeys() {
        context.validate();
        const length = vectorLength(context.arena, vector);
        return [...Array.from({ length }, (_unused, index) => String(index)), "length"];
      },
      getOwnPropertyDescriptor(_target, property) {
        context.validate();
        if (property === "length") {
          return {
            configurable: false,
            enumerable: false,
            writable: false,
            value: vectorLength(context.arena, vector),
          };
        }
        if (typeof property === "symbol" || !/^\d+$/.test(property)) return undefined;
        const element = vectorGet(context.arena, vector, Number(property));
        if (element === undefined) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: viewValue(context, element),
        };
      },
      set() {
        throw new TypeError("a snapshot is read only");
      },
    });
  });
}

/**
 * Maps and sets are materialised rather than proxied.
 *
 * A lazy Map would have to be a real Map to satisfy `instanceof` and the iteration protocol,
 * and a subclass that decodes on `get` cannot intercept `size` or the iterators without
 * surprising anyone who passes it to a library. Materialising is the honest option, and it
 * is memoised per version so it happens once.
 */
function mapView(context: ViewContext, slot: Slot): Map<unknown, unknown> {
  return cached(context, slot.payload, () => {
    context.validate();
    return new Map(
      hamtEntries(context.arena, slot.payload).map((entry) => [
        decodeValue(context.arena, entry.key),
        viewValue(context, entry.value),
      ]),
    );
  });
}

function setView(context: ViewContext, slot: Slot): Set<unknown> {
  return cached(context, slot.payload, () => {
    context.validate();
    return new Set(
      hamtEntries(context.arena, slot.payload).map((entry) =>
        decodeValue(context.arena, entry.key),
      ),
    );
  });
}

/**
 * Read one path without building views for the nodes along it.
 *
 * The fastest way to answer a question like "what is the count", and the shape the framework
 * bindings use for a selector.
 */
export function readPath(
  arena: SharedArena,
  root: Slot,
  path: readonly (string | number)[],
): unknown {
  let slot: Slot | undefined = root;
  for (const step of path) {
    if (slot === undefined) return undefined;
    if (slot.tag === Tag.Array) {
      slot = vectorGet(arena, slot.payload, Number(step));
      continue;
    }
    if (slot.tag === Tag.Object || slot.tag === Tag.Map) {
      slot = lookupSlot(arena, slot.payload, step);
      continue;
    }
    return undefined;
  }
  return slot === undefined ? undefined : decodeValue(arena, slot);
}

function lookupSlot(arena: SharedArena, node: number, key: string | number): Slot | undefined {
  if (typeof key === "number") {
    const slot: Slot = { tag: Tag.Int32, payload: key };
    return hamtGet(arena, node, slot, keyHash(arena, slot));
  }
  return hamtGetString(arena, node, key, hashString(key));
}

export { VIEW_SLOT };

/**
 * Compare two values by the arena node behind them.
 *
 * The default equality for a selector is `Object.is`, and for a selector that returns a
 * container that means a notification on every commit: each commit produces a new snapshot
 * with a fresh decode cache, so the view object is a new proxy even when the underlying
 * subtree did not move. Comparing the slots instead answers the question the selector
 * actually cares about, which is whether the subtree changed.
 *
 * Why comparing offsets is sound here, since it looks like it should not be. A commit
 * encodes the new value before it frees anything the old version held, so a newly written
 * node can never land on the block the current version is using. The value a selector last
 * saw is the current version's node, so a later node reusing that block always compares
 * unequal to it. The comparison dereferences nothing, so a wild offset cannot make it
 * misbehave either.
 *
 * It is still a comparison of representation rather than of value. Two structurally equal
 * subtrees written separately are different nodes and compare unequal, which is the
 * conservative direction: an extra render, never a missed one.
 */
export function sameNode(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  const left = viewSlot(a);
  const right = viewSlot(b);
  if (left === undefined || right === undefined) return false;
  return left.tag === right.tag && left.payload === right.payload;
}
