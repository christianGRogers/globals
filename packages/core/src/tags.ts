/**
 * Value tags.
 *
 * A slot is eight bytes, two 32 bit words: a tag word and a payload word. Small integers
 * and the singletons live entirely in the slot. Everything else stores a byte offset into
 * the arena, which is why every decode has to bounds check before it dereferences.
 */
export const Tag = {
  /** No payload. */
  Undefined: 0,
  /** No payload. */
  Null: 1,
  /** No payload. */
  False: 2,
  /** No payload. */
  True: 3,
  /** Payload is the value itself, in the signed 32 bit range. */
  Int32: 4,
  /** Payload is the byte offset of an eight byte float64. */
  Double: 5,
  /** Payload is the byte offset of an interned string record. */
  String: 6,
  /** Payload is the byte offset of a HAMT root. Added by the object layer. */
  Object: 7,
  /** Payload is the byte offset of a vector header. Added by the object layer. */
  Array: 8,
  /** Payload is the byte offset of a HAMT root with arbitrary keys. */
  Map: 9,
  /** Payload is the byte offset of a HAMT root used as a set. */
  Set: 10,
  /** Payload is the byte offset of an eight byte float64 holding epoch milliseconds. */
  Date: 11,
  /** Payload is the byte offset of a two word record: source string, flags string. */
  RegExp: 12,
  /** Payload is the byte offset of a length prefixed little endian byte sequence. */
  BigInt: 13,
  /** Payload is the byte offset of a kind, length, and byte payload record. */
  TypedArray: 14,
  /** Payload is a handle into the asynchronous tier. */
  External: 15,
} as const;

export type TagValue = (typeof Tag)[keyof typeof Tag];

const NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Tag).map(([name, value]) => [value, name]),
);

export function tagName(tag: number): string {
  return NAMES[tag] ?? `unknown(${tag})`;
}

export function isKnownTag(tag: number): tag is TagValue {
  return tag >= Tag.Undefined && tag <= Tag.External;
}

/** Tags whose payload is a byte offset that must be bounds checked before use. */
export function payloadIsOffset(tag: number): boolean {
  return tag >= Tag.Double && tag <= Tag.TypedArray;
}
