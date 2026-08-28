import type { SharedArena } from "./arena.js";
import type { Allocator } from "./allocator.js";
import { ArenaCorruptError } from "./errors.js";
import { WORD, align } from "./layout.js";
import { hashString } from "./checksum.js";

/**
 * Interned strings.
 *
 * Record layout, at the payload offset returned by the allocator:
 *
 *   word 0   hash, so a comparison can reject in one integer compare
 *   word 1   length in UTF-16 code units
 *   word 2.. the code units, packed two per word
 *
 * Strings are stored as UTF-16 rather than UTF-8 because JavaScript strings are UTF-16 and
 * the decode path is the hot one. Encoding to UTF-8 would halve the size of ASCII text and
 * add a conversion to every read, which is the wrong trade for this library.
 *
 * The table is append only. A string is never freed while the arena lives, which is the
 * documented cost of interning: equal keys share one record and comparison is an integer
 * compare, at the price of holding every distinct string ever written. Workloads that churn
 * through unbounded distinct strings should keep them in the asynchronous tier. Compaction
 * is a phase 5 question, and the soak harness reports the table size so the decision has
 * data behind it.
 */

const HEADER_WORDS = 2;
const HASH_WORD = 0;
const LENGTH_WORD = 1;

export function stringRecordBytes(length: number): number {
  return align(HEADER_WORDS * WORD + length * 2);
}

/** Owner side. Holds the intern map, which never leaves the writer process. */
export class StringTable {
  readonly #arena: SharedArena;
  readonly #allocator: Allocator;
  /** Interning map, keyed by the string itself. Only the owner has it. */
  readonly #interned = new Map<string, number>();

  constructor(arena: SharedArena, allocator: Allocator) {
    this.#arena = arena;
    this.#allocator = allocator;
  }

  get size(): number {
    return this.#interned.size;
  }

  /** Return the offset of `text`, writing it into the arena the first time it is seen. */
  intern(text: string): number {
    const existing = this.#interned.get(text);
    if (existing !== undefined) return existing;

    const offset = this.#allocator.allocate(stringRecordBytes(text.length));
    const words = this.#arena.words;
    const base = offset / WORD;
    words[base + HASH_WORD] = hashString(text);
    words[base + LENGTH_WORD] = text.length;

    const units = this.#arena.units;
    const unitBase = (offset + HEADER_WORDS * WORD) / 2;
    for (let i = 0; i < text.length; i += 1) {
      units[unitBase + i] = text.charCodeAt(i);
    }

    this.#interned.set(text, offset);
    return offset;
  }

  /** Bytes held by interned strings. Reported by the soak harness. */
  byteSize(): number {
    let total = 0;
    for (const text of this.#interned.keys()) total += stringRecordBytes(text.length);
    return total;
  }
}

/**
 * Decode a string record. Every field is validated before it is used, so a wild offset
 * produces an ArenaCorruptError rather than a very long string built from arbitrary bytes.
 */
export function decodeString(arena: SharedArena, offset: number): string {
  const byteSize = arena.checkBlock(offset, "string");
  const words = arena.words;
  const base = offset / WORD;
  const length = words[base + LENGTH_WORD] as number;

  if (length < 0 || stringRecordBytes(length) > byteSize) {
    throw new ArenaCorruptError(
      `string at ${offset} claims ${length} code units, which does not fit in ${byteSize} bytes`,
      { offset, actual: length },
    );
  }

  const units = arena.units;
  const unitBase = (offset + HEADER_WORDS * WORD) / 2;
  // fromCharCode with a subarray is measurably faster than a loop for typical key lengths,
  // and the chunking keeps the argument count away from the engine limit for long text.
  if (length <= 2048) {
    return String.fromCharCode(...units.subarray(unitBase, unitBase + length));
  }
  let out = "";
  for (let start = 0; start < length; start += 2048) {
    const end = Math.min(start + 2048, length);
    out += String.fromCharCode(...units.subarray(unitBase + start, unitBase + end));
  }
  return out;
}

/** The stored hash, for callers comparing keys without materialising the string. */
export function stringHash(arena: SharedArena, offset: number): number {
  arena.checkBlock(offset, "string hash");
  return arena.words[offset / WORD + HASH_WORD] as number;
}

/** Compare an interned record against a JavaScript string without allocating. */
export function stringEquals(arena: SharedArena, offset: number, text: string): boolean {
  const byteSize = arena.checkBlock(offset, "string compare");
  const words = arena.words;
  const base = offset / WORD;
  const length = words[base + LENGTH_WORD] as number;
  if (length !== text.length) return false;
  if (stringRecordBytes(length) > byteSize) {
    throw new ArenaCorruptError(`string at ${offset} has an impossible length`, { offset });
  }
  if ((words[base + HASH_WORD] as number) !== hashString(text)) return false;

  const units = arena.units;
  const unitBase = (offset + HEADER_WORDS * WORD) / 2;
  for (let i = 0; i < length; i += 1) {
    if (units[unitBase + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
