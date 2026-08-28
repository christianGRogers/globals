import type { SharedArena } from "./arena.js";
import { Tag } from "./tags.js";
import { UnencodableValueError } from "./errors.js";
import {
  EMPTY_NODE,
  emptyNode,
  hamtAssoc,
  hamtDissoc,
  hamtGet,
  hamtKeyStrings,
  keyHash,
} from "./hamt.js";
import {
  emptyVector,
  vectorAssoc,
  vectorFromSlots,
  vectorGet,
  vectorLength,
  vectorNodes,
} from "./vector.js";
import {
  collectBlocks,
  decodeValue,
  encodeString,
  encodeValue,
  type EncodeContext,
  type Slot,
} from "./values.js";

/**
 * A draft, in the style of immer.
 *
 * You mutate it and nothing published moves. On finalisation only the paths you touched are
 * rebuilt: a HAMT assoc copies at most seven nodes, a vector assoc copies one path, and every
 * subtree you did not touch keeps its existing arena offset. That is what makes retaining
 * several versions affordable, and it is the phase 2 exit criterion.
 *
 * What a draft deliberately does not do is alias. Assigning a value you read out of the store
 * into a second position encodes a copy rather than sharing nodes, because sharing would need
 * reference counting to reclaim correctly and every write would pay for a case almost no
 * application has.
 */

const DELETED = Symbol("globals.deleted");
const STATE = Symbol("globals.draftState");

type Modification = unknown;

interface DraftState {
  readonly base: Slot;
  readonly modifications: Map<string | number, Modification>;
  readonly children: Map<string | number, DraftNode>;
  dirty: boolean;
  /** For arrays, the length after modification, when it changed. */
  length: number | undefined;
}

export interface DraftNode {
  readonly state: DraftState;
  readonly proxy: unknown;
}

export interface DraftContext extends EncodeContext {
  readonly arena: SharedArena;
}

function isContainer(slot: Slot): boolean {
  return slot.tag === Tag.Object || slot.tag === Tag.Array;
}

export function createDraft(context: DraftContext, base: Slot): DraftNode {
  const state: DraftState = {
    base,
    modifications: new Map(),
    children: new Map(),
    dirty: false,
    length: undefined,
  };
  const proxy =
    base.tag === Tag.Array ? createArrayProxy(context, state) : createObjectProxy(context, state);
  return { state, proxy };
}

export function draftStateOf(value: unknown): DraftState | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const state = (value as Record<symbol, unknown>)[STATE];
  return state === undefined ? undefined : (state as DraftState);
}

function isDirty(state: DraftState): boolean {
  if (state.dirty) return true;
  for (const child of state.children.values()) {
    if (isDirty(child.state)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading through a draft
// ---------------------------------------------------------------------------

function childSlot(
  context: DraftContext,
  state: DraftState,
  key: string | number,
): Slot | undefined {
  if (state.base.tag === Tag.Array) {
    return vectorGet(context.arena, state.base.payload, Number(key));
  }
  if (state.base.tag !== Tag.Object) return undefined;
  const keySlot = encodeString(context, String(key));
  return hamtGet(context.arena, state.base.payload, keySlot, keyHash(context.arena, keySlot));
}

function readThrough(context: DraftContext, state: DraftState, key: string | number): unknown {
  if (state.modifications.has(key)) {
    const value = state.modifications.get(key);
    return value === DELETED ? undefined : value;
  }

  const existing = state.children.get(key);
  if (existing !== undefined) return existing.proxy;

  const slot = childSlot(context, state, key);
  if (slot === undefined) return undefined;

  if (isContainer(slot)) {
    // Creating a child draft does not mark anything dirty, so merely reading a nested object
    // costs nothing at commit time.
    const child = createDraft(context, slot);
    state.children.set(key, child);
    return child.proxy;
  }
  return decodeValue(context.arena, slot);
}

function draftKeys(context: DraftContext, state: DraftState): string[] {
  const base =
    state.base.tag === Tag.Object && state.base.payload !== EMPTY_NODE
      ? hamtKeyStrings(context.arena, state.base.payload)
      : [];
  const keys = base.filter((key) => state.modifications.get(key) !== DELETED);
  for (const [key, value] of state.modifications) {
    if (value === DELETED) continue;
    const name = String(key);
    if (!keys.includes(name)) keys.push(name);
  }
  return keys;
}

function toIndex(property: string): number | undefined {
  return /^\d+$/.test(property) ? Number(property) : undefined;
}

function draftLength(context: DraftContext, state: DraftState): number {
  if (state.length !== undefined) return state.length;
  return vectorLength(context.arena, state.base.payload);
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

function createObjectProxy(context: DraftContext, state: DraftState): unknown {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (property === STATE) return state;
      if (typeof property === "symbol") return undefined;
      return readThrough(context, state, property);
    },
    set(_target, property, value) {
      if (typeof property === "symbol") {
        throw new UnencodableValueError(value, "symbol keys have no cross process identity");
      }
      state.modifications.set(property, value);
      state.children.delete(property);
      state.dirty = true;
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property === "symbol") return true;
      state.modifications.set(property, DELETED);
      state.children.delete(property);
      state.dirty = true;
      return true;
    },
    has(_target, property) {
      if (typeof property === "symbol") return false;
      if (state.modifications.has(property)) return state.modifications.get(property) !== DELETED;
      return childSlot(context, state, property) !== undefined;
    },
    ownKeys() {
      return draftKeys(context, state);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === "symbol") return undefined;
      if (!draftKeys(context, state).includes(property)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: readThrough(context, state, property),
      };
    },
  });
}

/**
 * Array operations that cannot be expressed as a path copy.
 *
 * They materialise the array, apply the operation, and rebuild. That is linear in the array
 * length rather than logarithmic, which the documentation states rather than hides. Index
 * assignment, push, and pop stay on the fast path.
 */
const REBUILD_METHODS = new Set(["splice", "unshift", "shift", "sort", "reverse", "fill", "copyWithin"]);

function createArrayProxy(context: DraftContext, state: DraftState): unknown {
  return new Proxy([] as unknown[], {
    get(_target, property) {
      if (property === STATE) return state;
      if (property === "length") return draftLength(context, state);

      if (typeof property === "symbol") {
        if (property !== Symbol.iterator) return undefined;
        return function* iterate(): Generator<unknown> {
          const length = draftLength(context, state);
          for (let i = 0; i < length; i += 1) yield readThrough(context, state, i);
        };
      }

      const index = toIndex(property);
      if (index !== undefined) return readThrough(context, state, index);

      if (property === "push") {
        return (...values: unknown[]): number => {
          let length = draftLength(context, state);
          for (const value of values) {
            state.modifications.set(length, value);
            length += 1;
          }
          state.length = length;
          state.dirty = true;
          return length;
        };
      }

      if (property === "pop") {
        return (): unknown => {
          const length = draftLength(context, state);
          if (length === 0) return undefined;
          const value = toPlain(context, readThrough(context, state, length - 1));
          state.modifications.delete(length - 1);
          state.children.delete(length - 1);
          state.length = length - 1;
          state.dirty = true;
          return value;
        };
      }

      if (REBUILD_METHODS.has(property)) {
        return (...args: unknown[]): unknown => {
          const materialised = materialise(context, state);
          const method = Array.prototype[property as keyof typeof Array.prototype] as (
            this: unknown[],
            ...rest: unknown[]
          ) => unknown;
          const result = method.apply(materialised, args);
          state.modifications.clear();
          state.children.clear();
          materialised.forEach((value, index) => state.modifications.set(index, value));
          state.length = materialised.length;
          state.dirty = true;
          return result;
        };
      }

      // Everything else is a read only Array.prototype method. Materialising is honest: the
      // alternative is a partial reimplementation of the array protocol that differs from it
      // in ways nobody documents.
      const materialised = materialise(context, state);
      const value = (materialised as unknown as Record<string, unknown>)[property];
      return typeof value === "function" ? value.bind(materialised) : value;
    },
    set(_target, property, value) {
      if (property === "length") {
        state.length = Number(value);
        state.dirty = true;
        return true;
      }
      if (typeof property === "symbol") return true;
      const index = toIndex(property);
      if (index === undefined) return true;
      state.modifications.set(index, value);
      state.children.delete(index);
      if (index >= draftLength(context, state)) state.length = index + 1;
      state.dirty = true;
      return true;
    },
    has(_target, property) {
      if (property === "length") return true;
      if (typeof property === "symbol") return false;
      const index = toIndex(property);
      return index !== undefined && index < draftLength(context, state);
    },
    ownKeys() {
      const length = draftLength(context, state);
      return [...Array.from({ length }, (_unused, index) => String(index)), "length"];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === "length") {
        return {
          configurable: false,
          enumerable: false,
          writable: true,
          value: draftLength(context, state),
        };
      }
      if (typeof property === "symbol") return undefined;
      const index = toIndex(property);
      if (index === undefined || index >= draftLength(context, state)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: readThrough(context, state, index),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Materialising
// ---------------------------------------------------------------------------

/**
 * Turn a draft, or anything containing one, into a plain JavaScript value.
 *
 * This runs entirely on the JavaScript heap. Finalising the draft into the arena first and
 * decoding the result would be simpler to write and would leak: the intermediate nodes would
 * be allocated, never referenced by a published root, and never retired.
 */
function toPlain(context: DraftContext, value: unknown): unknown {
  const state = draftStateOf(value);
  if (state !== undefined) return materialiseState(context, state);
  return value;
}

function materialise(context: DraftContext, state: DraftState): unknown[] {
  const length = draftLength(context, state);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) out.push(toPlain(context, readThrough(context, state, i)));
  return out;
}

function materialiseState(context: DraftContext, state: DraftState): unknown {
  if (state.base.tag === Tag.Array) return materialise(context, state);
  const out: Record<string, unknown> = {};
  for (const key of draftKeys(context, state)) {
    out[key] = toPlain(context, readThrough(context, state, key));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finalising
// ---------------------------------------------------------------------------

/**
 * Turn a draft back into a slot.
 *
 * A clean draft returns its base slot unchanged, which is how untouched subtrees keep their
 * arena nodes. A dirty one applies its modifications through assoc, so only the copied path
 * is new and every replaced node lands on the retire list.
 */
export function finalizeState(context: DraftContext, state: DraftState): Slot {
  if (!isDirty(state)) return state.base;
  return state.base.tag === Tag.Array
    ? finalizeArray(context, state)
    : finalizeObject(context, state);
}

function retireSubtree(context: DraftContext, slot: Slot): void {
  for (const block of collectBlocks(context.arena, slot)) context.retired.push(block);
}

function finalizeObject(context: DraftContext, state: DraftState): Slot {
  let node = state.base.tag === Tag.Object ? state.base.payload : emptyNode(context);

  // Nested drafts first. Each one retires its own replaced nodes, so the old child slot needs
  // no separate retirement here.
  for (const [key, child] of state.children) {
    if (state.modifications.has(key) || !isDirty(child.state)) continue;
    const keySlot = encodeString(context, String(key));
    node = hamtAssoc(
      context,
      node,
      keySlot,
      keyHash(context.arena, keySlot),
      finalizeState(context, child.state),
    );
  }

  for (const [key, value] of state.modifications) {
    const keySlot = encodeString(context, String(key));
    const hash = keyHash(context.arena, keySlot);
    const previous = hamtGet(context.arena, node, keySlot, hash);

    node =
      value === DELETED
        ? hamtDissoc(context, node, keySlot, hash)
        : hamtAssoc(context, node, keySlot, hash, encodeValue(context, toPlain(context, value)));

    // The old value is unreachable from the new version, because drafts never alias.
    if (previous !== undefined) retireSubtree(context, previous);
  }

  return { tag: Tag.Object, payload: node };
}

function finalizeArray(context: DraftContext, state: DraftState): Slot {
  const baseLength = vectorLength(context.arena, state.base.payload);
  const targetLength = draftLength(context, state);

  const indexWritesOnly =
    targetLength === baseLength &&
    [...state.modifications.entries()].every(
      ([key, value]) => typeof key === "number" && key < baseLength && value !== DELETED,
    );

  // In place index updates are the case worth optimising, because that is what a table of
  // rows does on every edit. Anything that changes the length rebuilds.
  if (indexWritesOnly) {
    let vector = state.base.payload;

    for (const [key, child] of state.children) {
      if (state.modifications.has(key) || !isDirty(child.state)) continue;
      vector = vectorAssoc(context, vector, Number(key), finalizeState(context, child.state));
    }

    for (const [key, value] of state.modifications) {
      const index = Number(key);
      const previous = vectorGet(context.arena, vector, index);
      vector = vectorAssoc(
        context,
        vector,
        index,
        encodeValue(context, toPlain(context, value)),
      );
      if (previous !== undefined) retireSubtree(context, previous);
    }
    return { tag: Tag.Array, payload: vector };
  }

  const slots: Slot[] = [];
  const carried = new Set<number>();

  for (let index = 0; index < targetLength; index += 1) {
    if (state.modifications.has(index)) {
      const value = state.modifications.get(index);
      slots.push(
        value === DELETED
          ? { tag: Tag.Undefined, payload: 0 }
          : encodeValue(context, toPlain(context, value)),
      );
      continue;
    }
    const child = state.children.get(index);
    if (child !== undefined && isDirty(child.state)) {
      slots.push(finalizeState(context, child.state));
      continue;
    }
    const existing = vectorGet(context.arena, state.base.payload, index);
    if (existing === undefined) {
      slots.push({ tag: Tag.Undefined, payload: 0 });
      continue;
    }
    // Carried over unchanged, so this element must not be retired with the old spine.
    carried.add(index);
    slots.push(existing);
  }

  const rebuilt = vectorFromSlots(context, slots);

  // The old spine is garbage. Its elements are only garbage where they were replaced or
  // truncated away, because the rebuilt vector references the carried ones.
  for (let index = 0; index < baseLength; index += 1) {
    if (carried.has(index)) continue;
    const existing = vectorGet(context.arena, state.base.payload, index);
    if (existing !== undefined) retireSubtree(context, existing);
  }
  for (const node of vectorNodes(context.arena, state.base.payload)) context.retired.push(node);

  return { tag: Tag.Array, payload: rebuilt };
}

export function emptyObjectSlot(context: DraftContext): Slot {
  return { tag: Tag.Object, payload: emptyNode(context) };
}

export function emptyArraySlot(context: DraftContext): Slot {
  return { tag: Tag.Array, payload: emptyVector(context) };
}

export { STATE as DRAFT_STATE, DELETED as DRAFT_DELETED };
export type { DraftState };
