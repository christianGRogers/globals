import type { SharedArena } from "./arena.js";
import type { Allocator } from "./allocator.js";
import type { StringTable } from "./strings.js";
import { decodeString } from "./strings.js";
import { ArenaCorruptError, UnencodableValueError } from "./errors.js";
import { Tag, isKnownTag, tagName } from "./tags.js";
import { WORD } from "./layout.js";
import {
  EMPTY_NODE,
  emptyNode,
  hamtAssoc,
  hamtEntries,
  hamtNodes,
  hamtSize,
  keyHash,
  type HamtContext,
} from "./hamt.js";
import {
  EMPTY_VECTOR,
  vectorFromSlots,
  vectorLength,
  vectorNodes,
  vectorSlots,
} from "./vector.js";

/** A tagged eight byte slot, as a pair of 32 bit words. */
export interface Slot {
  readonly tag: number;
  readonly payload: number;
}

export const UNDEFINED_SLOT: Slot = { tag: Tag.Undefined, payload: 0 };
export const NULL_SLOT: Slot = { tag: Tag.Null, payload: 0 };
export const TRUE_SLOT: Slot = { tag: Tag.True, payload: 0 };

/** Typed array kinds, by index. The index is stored, so this list is append only. */
export const TYPED_ARRAY_KINDS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
] as const;

export type TypedArrayKind = (typeof TYPED_ARRAY_KINDS)[number];

const TYPED_ARRAY_ELEMENT_BYTES: Record<string, number> = {
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1,
  Int16Array: 2,
  Uint16Array: 2,
  Int32Array: 4,
  Uint32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
  BigInt64Array: 8,
  BigUint64Array: 8,
};

const TYPED_ARRAY_CONSTRUCTORS: Record<string, new (length: number) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

/**
 * An opaque handle into the asynchronous tier.
 *
 * Values that cannot be encoded are reached through a visibly different API rather than
 * throwing at some later point. The boundary between synchronous and asynchronous is meant
 * to be legible in the calling code, not a runtime surprise.
 */
export class ExternalRef {
  constructor(readonly handle: number) {}
  toJSON(): { external: number } {
    return { external: this.handle };
  }
}

export interface EncodeContext extends HamtContext {
  readonly arena: SharedArena;
  readonly allocator: Allocator;
  readonly strings: StringTable;
  /** Blocks the encoder allocated, so a failed commit can release them. */
  readonly allocated: number[];
  /** Nodes replaced on a copied path, retired when the superseded version is unreadable. */
  readonly retired: number[];
}

function isInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

function allocate(context: EncodeContext, bytes: number): number {
  const offset = context.allocator.allocate(bytes);
  context.allocated.push(offset);
  return offset;
}

export function encodeNumber(context: EncodeContext, value: number): Slot {
  // Negative zero has to take the double path. Encoded as an int32 it would read back as
  // positive zero, and Object.is would disagree with the value that went in.
  if (isInt32(value) && !Object.is(value, -0)) return { tag: Tag.Int32, payload: value };
  const offset = allocate(context, 8);
  context.arena.floats[offset / 8] = value;
  return { tag: Tag.Double, payload: offset };
}

export function encodeString(context: EncodeContext, value: string): Slot {
  // Interned, so the offset may be one the table already held. It is deliberately not added
  // to the allocated list: releasing it would free a record other versions still reference.
  return { tag: Tag.String, payload: context.strings.intern(value) };
}

/**
 * Encode a value into a slot.
 *
 * Containers are built from the bottom up, so a partially built structure is never
 * reachable from a published root. Anything outside the ladder raises
 * UnencodableValueError, which is the boundary the asynchronous tier exists to cover.
 */
export function encodeValue(context: EncodeContext, value: unknown): Slot {
  switch (typeof value) {
    case "undefined":
      return UNDEFINED_SLOT;
    case "boolean":
      return { tag: value ? Tag.True : Tag.False, payload: 0 };
    case "number":
      return encodeNumber(context, value);
    case "string":
      return encodeString(context, value);
    case "bigint":
      return encodeBigInt(context, value);
    case "symbol":
      throw new UnencodableValueError(value, "symbols have no cross process identity");
    case "function":
      throw new UnencodableValueError(value, "functions cannot cross a process boundary");
    case "object":
      break;
    default:
      throw new UnencodableValueError(value, `unsupported typeof result ${typeof value}`);
  }

  if (value === null) return NULL_SLOT;
  if (value instanceof ExternalRef) return { tag: Tag.External, payload: value.handle };
  if (value instanceof Date) return encodeDate(context, value);
  if (value instanceof RegExp) return encodeRegExp(context, value);
  if (Array.isArray(value)) return encodeArray(context, value);
  if (value instanceof Map) return encodeMap(context, value);
  if (value instanceof Set) return encodeSet(context, value);
  if (ArrayBuffer.isView(value)) return encodeTypedArray(context, value);

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnencodableValueError(
      value,
      "only plain objects are encodable, a class instance loses its prototype and its identity",
    );
  }
  return encodeObject(context, value as Record<string, unknown>);
}

function encodeDate(context: EncodeContext, value: Date): Slot {
  const offset = allocate(context, 8);
  context.arena.floats[offset / 8] = value.getTime();
  return { tag: Tag.Date, payload: offset };
}

function encodeRegExp(context: EncodeContext, value: RegExp): Slot {
  const source = context.strings.intern(value.source);
  const flags = context.strings.intern(value.flags);
  const offset = allocate(context, 2 * WORD);
  context.arena.words[offset / WORD] = source;
  context.arena.words[offset / WORD + 1] = flags;
  return { tag: Tag.RegExp, payload: offset };
}

function encodeBigInt(context: EncodeContext, value: bigint): Slot {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const digits: number[] = [];
  while (magnitude > 0n) {
    digits.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  const offset = allocate(context, 2 * WORD + Math.max(digits.length, 1));
  const words = context.arena.words;
  words[offset / WORD] = negative ? 1 : 0;
  words[offset / WORD + 1] = digits.length;
  const bytes = context.arena.bytes;
  for (let i = 0; i < digits.length; i += 1) bytes[offset + 2 * WORD + i] = digits[i] as number;
  return { tag: Tag.BigInt, payload: offset };
}

function encodeTypedArray(context: EncodeContext, value: ArrayBufferView): Slot {
  const kind = value.constructor.name;
  const kindIndex = TYPED_ARRAY_KINDS.indexOf(kind as TypedArrayKind);
  if (kindIndex === -1) {
    throw new UnencodableValueError(value, `${kind} is not on the typed array ladder`);
  }
  const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const offset = allocate(context, 2 * WORD + Math.max(value.byteLength, 1));
  const words = context.arena.words;
  words[offset / WORD] = kindIndex;
  words[offset / WORD + 1] = value.byteLength;
  context.arena.bytes.set(source, offset + 2 * WORD);
  return { tag: Tag.TypedArray, payload: offset };
}

function encodeArray(context: EncodeContext, value: readonly unknown[]): Slot {
  const slots = value.map((element) => encodeValue(context, element));
  return { tag: Tag.Array, payload: vectorFromSlots(context, slots) };
}

function encodeObject(context: EncodeContext, value: Record<string, unknown>): Slot {
  let node = emptyNode(context);
  for (const key of Object.keys(value)) {
    const keySlot = encodeString(context, key);
    const valueSlot = encodeValue(context, value[key]);
    node = hamtAssoc(context, node, keySlot, keyHash(context.arena, keySlot), valueSlot);
  }
  return { tag: Tag.Object, payload: node };
}

function encodeMap(context: EncodeContext, value: ReadonlyMap<unknown, unknown>): Slot {
  let node = emptyNode(context);
  for (const [key, entry] of value) {
    const keySlot = encodeValue(context, key);
    assertKeyable(keySlot, key);
    node = hamtAssoc(
      context,
      node,
      keySlot,
      keyHash(context.arena, keySlot),
      encodeValue(context, entry),
    );
  }
  return { tag: Tag.Map, payload: node };
}

function encodeSet(context: EncodeContext, value: ReadonlySet<unknown>): Slot {
  let node = emptyNode(context);
  for (const member of value) {
    const keySlot = encodeValue(context, member);
    assertKeyable(keySlot, member);
    node = hamtAssoc(context, node, keySlot, keyHash(context.arena, keySlot), TRUE_SLOT);
  }
  return { tag: Tag.Set, payload: node };
}

/**
 * Keys have to be comparable by their slot, so a container cannot be one.
 *
 * Object identity does not survive a process boundary, so a map keyed on an object would be
 * a map nobody could look anything up in. Rejecting it is better than encoding it into
 * something that silently never matches.
 */
function assertKeyable(slot: Slot, original: unknown): void {
  const keyable =
    slot.tag === Tag.String ||
    slot.tag === Tag.Int32 ||
    slot.tag === Tag.Double ||
    slot.tag === Tag.True ||
    slot.tag === Tag.False ||
    slot.tag === Tag.Null ||
    slot.tag === Tag.Undefined;
  if (!keyable) {
    throw new UnencodableValueError(
      original,
      "map and set keys must be primitives, because object identity does not cross a process",
    );
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a slot eagerly, materialising the whole structure.
 *
 * Used by `toJSON`, by tests, and by any caller that wants a detached plain value. The lazy
 * proxy path in snapshot-proxy.ts is what a render actually uses, because it decodes only
 * the properties that are touched.
 *
 * Every branch that dereferences an offset validates it first. Any window mapping the arena
 * can write a slot, so a wild offset is a reachable state rather than a bug that cannot
 * happen.
 */
export function decodeValue(arena: SharedArena, slot: Slot): unknown {
  const { tag, payload } = slot;

  if (!isKnownTag(tag)) {
    throw new ArenaCorruptError(`slot carries an unknown tag ${tag}`, { actual: tag });
  }

  switch (tag) {
    case Tag.Undefined:
      return undefined;
    case Tag.Null:
      return null;
    case Tag.False:
      return false;
    case Tag.True:
      return true;
    case Tag.Int32:
      return payload;
    case Tag.Double:
      arena.checkBlock(payload, "double");
      return arena.floats[payload / 8];
    case Tag.String:
      return decodeString(arena, payload);
    case Tag.Date:
      arena.checkBlock(payload, "date");
      return new Date(arena.floats[payload / 8] as number);
    case Tag.RegExp:
      return decodeRegExp(arena, payload);
    case Tag.BigInt:
      return decodeBigInt(arena, payload);
    case Tag.TypedArray:
      return decodeTypedArray(arena, payload);
    case Tag.Object:
      return decodeObject(arena, payload);
    case Tag.Array:
      return vectorSlots(arena, payload).map((element) => decodeValue(arena, element));
    case Tag.Map:
      return new Map(
        hamtEntries(arena, payload).map((entry) => [
          decodeValue(arena, entry.key),
          decodeValue(arena, entry.value),
        ]),
      );
    case Tag.Set:
      return new Set(hamtEntries(arena, payload).map((entry) => decodeValue(arena, entry.key)));
    case Tag.External:
      return new ExternalRef(payload);
    default:
      throw new ArenaCorruptError(`tag ${tagName(tag)} has no decoder`, { actual: tag });
  }
}

function decodeObject(arena: SharedArena, node: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of hamtEntries(arena, node)) {
    if (entry.key.tag !== Tag.String) {
      throw new ArenaCorruptError("object key is not a string", { actual: entry.key.tag });
    }
    out[decodeString(arena, entry.key.payload)] = decodeValue(arena, entry.value);
  }
  return out;
}

function decodeRegExp(arena: SharedArena, offset: number): RegExp {
  const byteSize = arena.checkBlock(offset, "regexp");
  if (byteSize < 2 * WORD) {
    throw new ArenaCorruptError(`regexp record at ${offset} is too small`, { offset });
  }
  const source = decodeString(arena, arena.words[offset / WORD] as number);
  const flags = decodeString(arena, arena.words[offset / WORD + 1] as number);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new ArenaCorruptError(
      `regexp record at ${offset} does not describe a valid expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { offset },
    );
  }
}

function decodeBigInt(arena: SharedArena, offset: number): bigint {
  const byteSize = arena.checkBlock(offset, "bigint");
  const negative = (arena.words[offset / WORD] as number) === 1;
  const length = arena.words[offset / WORD + 1] as number;
  if (length < 0 || 2 * WORD + length > byteSize) {
    throw new ArenaCorruptError(`bigint at ${offset} claims ${length} bytes`, { offset });
  }
  let value = 0n;
  const bytes = arena.bytes;
  for (let i = length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + 2 * WORD + i] as number);
  }
  return negative ? -value : value;
}

function decodeTypedArray(arena: SharedArena, offset: number): ArrayBufferView {
  const byteSize = arena.checkBlock(offset, "typed array");
  const kindIndex = arena.words[offset / WORD] as number;
  const byteLength = arena.words[offset / WORD + 1] as number;
  const kind = TYPED_ARRAY_KINDS[kindIndex];
  if (kind === undefined) {
    throw new ArenaCorruptError(`typed array at ${offset} has kind ${kindIndex}`, { offset });
  }
  if (byteLength < 0 || 2 * WORD + byteLength > byteSize) {
    throw new ArenaCorruptError(`typed array at ${offset} claims ${byteLength} bytes`, { offset });
  }

  const Constructor = TYPED_ARRAY_CONSTRUCTORS[kind];
  const elementBytes = TYPED_ARRAY_ELEMENT_BYTES[kind];
  if (Constructor === undefined || elementBytes === undefined) {
    throw new ArenaCorruptError(`typed array kind ${kind} is not constructible here`, { offset });
  }
  if (byteLength % elementBytes !== 0) {
    throw new ArenaCorruptError(
      `typed array at ${offset} has ${byteLength} bytes, which is not a whole number of ` +
        `${kind} elements`,
      { offset },
    );
  }

  const result = new Constructor(byteLength / elementBytes);
  new Uint8Array(result.buffer).set(
    arena.bytes.subarray(offset + 2 * WORD, offset + 2 * WORD + byteLength),
  );
  return result;
}

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

/**
 * Every block reachable from a slot, for retiring a structure the writer is replacing
 * outright.
 *
 * Interned strings are deliberately absent. They are shared between versions and freed only
 * when the arena is discarded, which is the documented cost of interning.
 *
 * This is the wholesale path. A targeted update collects retired nodes from the path copies
 * it performs, which is bounded rather than proportional to the structure.
 */
export function collectBlocks(arena: SharedArena, slot: Slot, out: number[] = []): number[] {
  switch (slot.tag) {
    case Tag.Double:
    case Tag.Date:
    case Tag.RegExp:
    case Tag.BigInt:
    case Tag.TypedArray:
      out.push(slot.payload);
      return out;
    case Tag.Object:
    case Tag.Map:
    case Tag.Set: {
      if (slot.payload === EMPTY_NODE) return out;
      for (const entry of hamtEntries(arena, slot.payload)) {
        collectBlocks(arena, entry.key, out);
        collectBlocks(arena, entry.value, out);
      }
      hamtNodes(arena, slot.payload, out);
      return out;
    }
    case Tag.Array: {
      if (slot.payload === EMPTY_VECTOR) return out;
      for (const element of vectorSlots(arena, slot.payload)) collectBlocks(arena, element, out);
      vectorNodes(arena, slot.payload, out);
      return out;
    }
    default:
      return out;
  }
}

/** The element or entry count of a container, without materialising it. */
export function containerSize(arena: SharedArena, slot: Slot): number {
  switch (slot.tag) {
    case Tag.Object:
    case Tag.Map:
    case Tag.Set:
      return hamtSize(arena, slot.payload);
    case Tag.Array:
      return vectorLength(arena, slot.payload);
    default:
      return 0;
  }
}
