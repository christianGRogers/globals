import type { SharedArena } from "./arena.js";
import type { Allocator } from "./allocator.js";
import { ArenaCorruptError } from "./errors.js";
import { WORD } from "./layout.js";
import { Tag } from "./tags.js";
import { decodeString, stringEquals, stringHash } from "./strings.js";
import type { Slot } from "./values.js";

/**
 * A hash array mapped trie, used for objects, maps, and sets.
 *
 * The point of it is structural sharing. Setting one field of an object with ten thousand
 * keys copies the path from the root to that key, which is at most seven nodes, rather than
 * the whole record. That is what keeps write cost logarithmic and makes retention of several
 * versions affordable.
 *
 * Node layout, at the payload offset the allocator returns:
 *
 *   word 0   kind, BITMAP or COLLISION
 *   BITMAP    word 1 dataMap, word 2 nodeMap
 *             then popcount(dataMap) entries of three words: key tag, key payload, and a
 *             value slot packed as two words
 *             then popcount(nodeMap) child offsets, one word each
 *   COLLISION word 1 entry count, word 2 the shared hash
 *             then count entries of four words: key tag, key payload, value tag, value
 *             payload
 *
 * An explicit kind word costs four bytes per node and buys two things: collision nodes are
 * distinguishable without stealing a bitmap value, and a wild offset that happens to land on
 * plausible bitmaps is rejected rather than walked.
 */

export const HAMT_BITMAP = 0x484d4200;
export const HAMT_COLLISION = 0x484d4201;

const KIND = 0;
const MAP_A = 1;
const MAP_B = 2;
const HEADER_WORDS = 3;
const ENTRY_WORDS = 4;
const BITS = 5;
const WIDTH = 1 << BITS;
const MASK = WIDTH - 1;
/** Six full levels use thirty bits. The seventh level carries the remaining two. */
const MAX_SHIFT = 30;

export const EMPTY_NODE = 0;

function popcount(bits: number): number {
  let value = bits - ((bits >>> 1) & 0x55555555);
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  value = (value + (value >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(value, 0x01010101) >>> 24) & 0x3f;
}

function fragment(hash: number, shift: number): number {
  return (hash >>> shift) & MASK;
}

/** The hash a key slot contributes to the trie. */
export function keyHash(arena: SharedArena, key: Slot): number {
  switch (key.tag) {
    case Tag.String:
      return stringHash(arena, key.payload);
    case Tag.Int32:
      return Math.imul(key.payload, 0x9e3779b1) | 0;
    case Tag.Double: {
      arena.checkBlock(key.payload, "map key");
      const value = arena.floats[key.payload / 8] as number;
      // Integral doubles must hash like the int32 that equals them, or a map keyed on 2 ** 40
      // and one keyed on a small integer would disagree with SameValueZero.
      if (Number.isInteger(value) && Math.abs(value) <= 2147483647) {
        return Math.imul(value, 0x9e3779b1) | 0;
      }
      const bytes = new Float64Array(1);
      bytes[0] = value;
      const words = new Int32Array(bytes.buffer);
      return (Math.imul(words[0] as number, 0x9e3779b1) ^ (words[1] as number)) | 0;
    }
    case Tag.True:
      return 0x7a5b3c1d;
    case Tag.False:
      return 0x1d3c5b7a;
    case Tag.Null:
      return 0x4e554c4c;
    case Tag.Undefined:
      return 0x554e4446;
    default:
      throw new ArenaCorruptError(`tag ${key.tag} cannot be a key`, { actual: key.tag });
  }
}

/**
 * Key equality, SameValueZero.
 *
 * Interned strings compare by offset, which is the whole reason for interning: an object
 * property lookup is an integer compare rather than a character walk. Doubles have to be
 * compared by value, because two equal doubles live in two different blocks.
 */
export function keyEquals(arena: SharedArena, a: Slot, b: Slot): boolean {
  if (a.tag === b.tag) {
    if (a.tag === Tag.Double) {
      arena.checkBlock(a.payload, "map key");
      arena.checkBlock(b.payload, "map key");
      const left = arena.floats[a.payload / 8] as number;
      const right = arena.floats[b.payload / 8] as number;
      return left === right || (Number.isNaN(left) && Number.isNaN(right));
    }
    return a.payload === b.payload;
  }
  // An int32 and a double can hold the same number, so the cross tag case is real.
  if (a.tag === Tag.Int32 && b.tag === Tag.Double) {
    arena.checkBlock(b.payload, "map key");
    return (arena.floats[b.payload / 8] as number) === a.payload;
  }
  if (a.tag === Tag.Double && b.tag === Tag.Int32) {
    arena.checkBlock(a.payload, "map key");
    return (arena.floats[a.payload / 8] as number) === b.payload;
  }
  return false;
}

export interface HamtContext {
  readonly arena: SharedArena;
  readonly allocator: Allocator;
  /** Nodes replaced on the copied path. The commit retires them. */
  readonly retired: number[];
  /**
   * Every block this operation allocated.
   *
   * A commit that fails part way releases these, so a rejected write leaks nothing. It is a
   * separate list from the retired one on purpose: retired blocks belong to the previous
   * version and must survive a rollback, allocated ones must not.
   */
  readonly allocated: number[];
}

function readKind(arena: SharedArena, node: number): number {
  const byteSize = arena.checkBlock(node, "hamt node");
  if (byteSize < HEADER_WORDS * WORD) {
    throw new ArenaCorruptError(`hamt node at ${node} is too small`, { offset: node });
  }
  const kind = arena.words[node / WORD + KIND] as number;
  if (kind !== HAMT_BITMAP && kind !== HAMT_COLLISION) {
    throw new ArenaCorruptError(`hamt node at ${node} has kind ${kind}`, { offset: node });
  }
  return kind;
}

/**
 * The entry count of a collision node, validated against the block that holds it.
 *
 * The bitmap node has always had this check through its popcount, which cannot exceed 32. The
 * collision node stores its count as a plain integer, and nothing validated it, so a corrupt
 * value sent every walker off to visit two billion entries. The loops that consume it have no
 * budget check inside them, so this is where it has to be caught.
 */
function collisionCount(arena: SharedArena, node: number): number {
  const byteSize = arena.checkBlock(node, "hamt collision node");
  const count = arena.words[node / WORD + MAP_A] as number;
  if (count < 0 || (HEADER_WORDS + count * ENTRY_WORDS) * WORD > byteSize) {
    throw new ArenaCorruptError(
      `hamt collision node at ${node} claims ${count} entries, which does not fit in ` +
        `${byteSize} bytes`,
      { offset: node, actual: count },
    );
  }
  return count;
}

function bitmapLayout(
  arena: SharedArena,
  node: number,
): { dataCount: number; nodeCount: number; base: number } {
  const base = node / WORD;
  const dataCount = popcount(arena.words[base + MAP_A] as number);
  const nodeCount = popcount(arena.words[base + MAP_B] as number);
  const needed = (HEADER_WORDS + dataCount * ENTRY_WORDS + nodeCount) * WORD;
  const byteSize = arena.checkBlock(node, "hamt bitmap node");
  if (needed > byteSize) {
    throw new ArenaCorruptError(
      `hamt node at ${node} claims ${dataCount} entries and ${nodeCount} children, which does ` +
        `not fit in ${byteSize} bytes`,
      { offset: node },
    );
  }
  return { dataCount, nodeCount, base };
}

function allocBitmap(
  context: HamtContext,
  dataMap: number,
  nodeMap: number,
  dataCount: number,
  nodeCount: number,
): number {
  const bytes = (HEADER_WORDS + dataCount * ENTRY_WORDS + nodeCount) * WORD;
  const offset = context.allocator.allocate(bytes);
  context.allocated.push(offset);
  const words = context.arena.words;
  const base = offset / WORD;
  words[base + KIND] = HAMT_BITMAP;
  words[base + MAP_A] = dataMap;
  words[base + MAP_B] = nodeMap;
  return offset;
}

function dataIndex(base: number, index: number): number {
  return base + HEADER_WORDS + index * ENTRY_WORDS;
}

function childIndex(base: number, dataCount: number, index: number): number {
  return base + HEADER_WORDS + dataCount * ENTRY_WORDS + index;
}

export function emptyNode(context: HamtContext): number {
  return allocBitmap(context, 0, 0, 0, 0);
}

/** Look a key up. Returns undefined when it is absent, which a null value slot cannot be. */
export function hamtGet(arena: SharedArena, node: number, key: Slot, hash: number): Slot | undefined {
  let current = node;
  let shift = 0;

  for (;;) {
    if (current === EMPTY_NODE) return undefined;
    const kind = readKind(arena, current);

    if (kind === HAMT_COLLISION) {
      const base = current / WORD;
      const count = collisionCount(arena, current);
      for (let i = 0; i < count; i += 1) {
        const at = dataIndex(base, i);
        const candidate: Slot = {
          tag: arena.words[at] as number,
          payload: arena.words[at + 1] as number,
        };
        if (keyEquals(arena, candidate, key)) {
          return { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number };
        }
      }
      return undefined;
    }

    const { dataCount, base } = bitmapLayout(arena, current);
    const bit = 1 << fragment(hash, shift);
    const dataMap = arena.words[base + MAP_A] as number;
    const nodeMap = arena.words[base + MAP_B] as number;

    if ((dataMap & bit) !== 0) {
      const index = popcount(dataMap & (bit - 1));
      const at = dataIndex(base, index);
      const candidate: Slot = {
        tag: arena.words[at] as number,
        payload: arena.words[at + 1] as number,
      };
      if (!keyEquals(arena, candidate, key)) return undefined;
      return { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number };
    }

    if ((nodeMap & bit) === 0) return undefined;
    const index = popcount(nodeMap & (bit - 1));
    current = arena.words[childIndex(base, dataCount, index)] as number;
    shift += BITS;
    if (shift > MAX_SHIFT + BITS) {
      throw new ArenaCorruptError("hamt lookup exceeded the maximum depth", { offset: node });
    }
  }
}

function copyEntry(words: Int32Array, from: number, to: number): void {
  words[to] = words[from] as number;
  words[to + 1] = words[from + 1] as number;
  words[to + 2] = words[from + 2] as number;
  words[to + 3] = words[from + 3] as number;
}

function writeEntry(words: Int32Array, at: number, key: Slot, value: Slot): void {
  words[at] = key.tag;
  words[at + 1] = key.payload;
  words[at + 2] = value.tag;
  words[at + 3] = value.payload;
}

function allocCollision(context: HamtContext, hash: number, count: number): number {
  const offset = context.allocator.allocate((HEADER_WORDS + count * ENTRY_WORDS) * WORD);
  context.allocated.push(offset);
  const words = context.arena.words;
  const base = offset / WORD;
  words[base + KIND] = HAMT_COLLISION;
  words[base + MAP_A] = count;
  words[base + MAP_B] = hash;
  return offset;
}

/** Build a node holding two entries whose hashes differ somewhere at or below `shift`. */
function mergeEntries(
  context: HamtContext,
  shift: number,
  keyA: Slot,
  valueA: Slot,
  hashA: number,
  keyB: Slot,
  valueB: Slot,
  hashB: number,
): number {
  if (shift > MAX_SHIFT) {
    const node = allocCollision(context, hashA, 2);
    const words = context.arena.words;
    const base = node / WORD;
    writeEntry(words, dataIndex(base, 0), keyA, valueA);
    writeEntry(words, dataIndex(base, 1), keyB, valueB);
    return node;
  }

  const fragmentA = fragment(hashA, shift);
  const fragmentB = fragment(hashB, shift);

  if (fragmentA === fragmentB) {
    const child = mergeEntries(context, shift + BITS, keyA, valueA, hashA, keyB, valueB, hashB);
    const node = allocBitmap(context, 0, 1 << fragmentA, 0, 1);
    context.arena.words[childIndex(node / WORD, 0, 0)] = child;
    return node;
  }

  const dataMap = (1 << fragmentA) | (1 << fragmentB);
  const node = allocBitmap(context, dataMap, 0, 2, 0);
  const words = context.arena.words;
  const base = node / WORD;
  const firstIsA = fragmentA < fragmentB;
  writeEntry(words, dataIndex(base, 0), firstIsA ? keyA : keyB, firstIsA ? valueA : valueB);
  writeEntry(words, dataIndex(base, 1), firstIsA ? keyB : keyA, firstIsA ? valueB : valueA);
  return node;
}

/**
 * Insert or replace a key, returning the new root of this subtree.
 *
 * Every node on the path from the root to the key is copied and the original is pushed onto
 * the retired list. Nothing already published is mutated, which is what makes a reader
 * holding an older root safe without any coordination.
 */
export function hamtAssoc(
  context: HamtContext,
  node: number,
  key: Slot,
  hash: number,
  value: Slot,
  shift = 0,
): number {
  const arena = context.arena;

  if (node === EMPTY_NODE) {
    const bit = 1 << fragment(hash, shift);
    const created = allocBitmap(context, bit, 0, 1, 0);
    writeEntry(arena.words, dataIndex(created / WORD, 0), key, value);
    return created;
  }

  const kind = readKind(arena, node);

  if (kind === HAMT_COLLISION) {
    const base = node / WORD;
    const count = collisionCount(arena, node);
    const storedHash = arena.words[base + MAP_B] as number;
    let existing = -1;
    for (let i = 0; i < count; i += 1) {
      const at = dataIndex(base, i);
      const candidate: Slot = {
        tag: arena.words[at] as number,
        payload: arena.words[at + 1] as number,
      };
      if (keyEquals(arena, candidate, key)) {
        existing = i;
        break;
      }
    }

    const newCount = existing === -1 ? count + 1 : count;
    const created = allocCollision(context, storedHash, newCount);
    const words = arena.words;
    const newBase = created / WORD;
    for (let i = 0; i < count; i += 1) {
      copyEntry(words, dataIndex(base, i), dataIndex(newBase, i));
    }
    writeEntry(words, dataIndex(newBase, existing === -1 ? count : existing), key, value);
    context.retired.push(node);
    return created;
  }

  const { dataCount, nodeCount, base } = bitmapLayout(arena, node);
  const dataMap = arena.words[base + MAP_A] as number;
  const nodeMap = arena.words[base + MAP_B] as number;
  const bit = 1 << fragment(hash, shift);

  if ((nodeMap & bit) !== 0) {
    const index = popcount(nodeMap & (bit - 1));
    const childOffset = arena.words[childIndex(base, dataCount, index)] as number;
    const newChild = hamtAssoc(context, childOffset, key, hash, value, shift + BITS);
    if (newChild === childOffset) return node;

    const created = allocBitmap(context, dataMap, nodeMap, dataCount, nodeCount);
    const words = arena.words;
    const newBase = created / WORD;
    for (let i = 0; i < dataCount; i += 1) {
      copyEntry(words, dataIndex(base, i), dataIndex(newBase, i));
    }
    for (let i = 0; i < nodeCount; i += 1) {
      words[childIndex(newBase, dataCount, i)] = words[
        childIndex(base, dataCount, i)
      ] as number;
    }
    words[childIndex(newBase, dataCount, index)] = newChild;
    context.retired.push(node);
    return created;
  }

  if ((dataMap & bit) !== 0) {
    const index = popcount(dataMap & (bit - 1));
    const at = dataIndex(base, index);
    const existingKey: Slot = {
      tag: arena.words[at] as number,
      payload: arena.words[at + 1] as number,
    };

    if (keyEquals(arena, existingKey, key)) {
      const created = allocBitmap(context, dataMap, nodeMap, dataCount, nodeCount);
      const words = arena.words;
      const newBase = created / WORD;
      for (let i = 0; i < dataCount; i += 1) {
        copyEntry(words, dataIndex(base, i), dataIndex(newBase, i));
      }
      for (let i = 0; i < nodeCount; i += 1) {
        words[childIndex(newBase, dataCount, i)] = words[
          childIndex(base, dataCount, i)
        ] as number;
      }
      writeEntry(words, dataIndex(newBase, index), key, value);
      context.retired.push(node);
      return created;
    }

    // Two different keys want the same slot. Push both down a level.
    const existingValue: Slot = {
      tag: arena.words[at + 2] as number,
      payload: arena.words[at + 3] as number,
    };
    const child = mergeEntries(
      context,
      shift + BITS,
      existingKey,
      existingValue,
      keyHash(arena, existingKey),
      key,
      value,
      hash,
    );

    const newDataMap = dataMap & ~bit;
    const newNodeMap = nodeMap | bit;
    const created = allocBitmap(context, newDataMap, newNodeMap, dataCount - 1, nodeCount + 1);
    const words = arena.words;
    const newBase = created / WORD;

    let target = 0;
    for (let i = 0; i < dataCount; i += 1) {
      if (i === index) continue;
      copyEntry(words, dataIndex(base, i), dataIndex(newBase, target));
      target += 1;
    }
    const childSlot = popcount(newNodeMap & (bit - 1));
    let source = 0;
    for (let i = 0; i < nodeCount + 1; i += 1) {
      if (i === childSlot) {
        words[childIndex(newBase, dataCount - 1, i)] = child;
        continue;
      }
      words[childIndex(newBase, dataCount - 1, i)] = words[
        childIndex(base, dataCount, source)
      ] as number;
      source += 1;
    }
    context.retired.push(node);
    return created;
  }

  // The slot is free, so the entry goes inline.
  const index = popcount(dataMap & (bit - 1));
  const created = allocBitmap(context, dataMap | bit, nodeMap, dataCount + 1, nodeCount);
  const words = arena.words;
  const newBase = created / WORD;
  for (let i = 0; i < index; i += 1) {
    copyEntry(words, dataIndex(base, i), dataIndex(newBase, i));
  }
  writeEntry(words, dataIndex(newBase, index), key, value);
  for (let i = index; i < dataCount; i += 1) {
    copyEntry(words, dataIndex(base, i), dataIndex(newBase, i + 1));
  }
  for (let i = 0; i < nodeCount; i += 1) {
    words[childIndex(newBase, dataCount + 1, i)] = words[
      childIndex(base, dataCount, i)
    ] as number;
  }
  context.retired.push(node);
  return created;
}

/** Remove a key. Returns the node unchanged when the key is absent. */
export function hamtDissoc(
  context: HamtContext,
  node: number,
  key: Slot,
  hash: number,
  shift = 0,
): number {
  const arena = context.arena;
  if (node === EMPTY_NODE) return node;
  const kind = readKind(arena, node);

  if (kind === HAMT_COLLISION) {
    const base = node / WORD;
    const count = collisionCount(arena, node);
    const storedHash = arena.words[base + MAP_B] as number;
    let existing = -1;
    for (let i = 0; i < count; i += 1) {
      const at = dataIndex(base, i);
      const candidate: Slot = {
        tag: arena.words[at] as number,
        payload: arena.words[at + 1] as number,
      };
      if (keyEquals(arena, candidate, key)) {
        existing = i;
        break;
      }
    }
    if (existing === -1) return node;

    const created = allocCollision(context, storedHash, count - 1);
    const words = arena.words;
    const newBase = created / WORD;
    let target = 0;
    for (let i = 0; i < count; i += 1) {
      if (i === existing) continue;
      copyEntry(words, dataIndex(base, i), dataIndex(newBase, target));
      target += 1;
    }
    context.retired.push(node);
    return created;
  }

  const { dataCount, nodeCount, base } = bitmapLayout(arena, node);
  const dataMap = arena.words[base + MAP_A] as number;
  const nodeMap = arena.words[base + MAP_B] as number;
  const bit = 1 << fragment(hash, shift);

  if ((dataMap & bit) !== 0) {
    const index = popcount(dataMap & (bit - 1));
    const at = dataIndex(base, index);
    const candidate: Slot = {
      tag: arena.words[at] as number,
      payload: arena.words[at + 1] as number,
    };
    if (!keyEquals(arena, candidate, key)) return node;

    const created = allocBitmap(context, dataMap & ~bit, nodeMap, dataCount - 1, nodeCount);
    const words = arena.words;
    const newBase = created / WORD;
    let target = 0;
    for (let i = 0; i < dataCount; i += 1) {
      if (i === index) continue;
      copyEntry(words, dataIndex(base, i), dataIndex(newBase, target));
      target += 1;
    }
    for (let i = 0; i < nodeCount; i += 1) {
      words[childIndex(newBase, dataCount - 1, i)] = words[
        childIndex(base, dataCount, i)
      ] as number;
    }
    context.retired.push(node);
    return created;
  }

  if ((nodeMap & bit) === 0) return node;

  const index = popcount(nodeMap & (bit - 1));
  const childOffset = arena.words[childIndex(base, dataCount, index)] as number;
  const newChild = hamtDissoc(context, childOffset, key, hash, shift + BITS);
  if (newChild === childOffset) return node;

  const created = allocBitmap(context, dataMap, nodeMap, dataCount, nodeCount);
  const words = arena.words;
  const newBase = created / WORD;
  for (let i = 0; i < dataCount; i += 1) {
    copyEntry(words, dataIndex(base, i), dataIndex(newBase, i));
  }
  for (let i = 0; i < nodeCount; i += 1) {
    words[childIndex(newBase, dataCount, i)] = words[childIndex(base, dataCount, i)] as number;
  }
  words[childIndex(newBase, dataCount, index)] = newChild;
  context.retired.push(node);
  return created;
}

export interface HamtEntry {
  readonly key: Slot;
  readonly value: Slot;
}

/**
 * The deepest a correct trie can be.
 *
 * Seven levels of five bits covers a 32 bit hash, plus one for a collision node. A traversal
 * that goes deeper is walking a cycle, which a corrupt child pointer can create.
 */
const MAX_DEPTH = 8;

/**
 * The most entries a traversal will visit before giving up.
 *
 * A depth bound alone is not enough, and this is the part that is easy to get wrong. Eight
 * levels with thirty two children each is 32 to the eighth, about a trillion visits, so a
 * corrupt trie that fans out and points back at itself stays inside the depth bound and still
 * exhausts the heap. The fuzzer found this by running the process out of memory after ten
 * minutes rather than by throwing.
 *
 * An entry occupies four words inside a node, so a buffer cannot hold more than its length
 * divided by sixteen of them however it is arranged.
 */
function traversalBudget(arena: SharedArena): number {
  return Math.ceil(arena.byteLength / 16);
}

/** Every entry in the subtree. Order is the trie order, which is stable for a given set. */
export function hamtEntries(
  arena: SharedArena,
  node: number,
  out: HamtEntry[] = [],
  depth = 0,
  budget = traversalBudget(arena),
): HamtEntry[] {
  if (node === EMPTY_NODE) return out;
  if (depth > MAX_DEPTH) {
    throw new ArenaCorruptError(`hamt traversal exceeded ${MAX_DEPTH} levels`, { offset: node });
  }
  if (out.length > budget) {
    throw new ArenaCorruptError(
      `hamt traversal exceeded ${budget} entries, which is more than the buffer can hold`,
      { offset: node },
    );
  }
  const kind = readKind(arena, node);
  const base = node / WORD;

  if (kind === HAMT_COLLISION) {
    const count = collisionCount(arena, node);
    for (let i = 0; i < count; i += 1) {
      const at = dataIndex(base, i);
      out.push({
        key: { tag: arena.words[at] as number, payload: arena.words[at + 1] as number },
        value: { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number },
      });
    }
    return out;
  }

  const { dataCount, nodeCount } = bitmapLayout(arena, node);
  for (let i = 0; i < dataCount; i += 1) {
    const at = dataIndex(base, i);
    out.push({
      key: { tag: arena.words[at] as number, payload: arena.words[at + 1] as number },
      value: { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number },
    });
  }
  for (let i = 0; i < nodeCount; i += 1) {
    hamtEntries(
      arena,
      arena.words[childIndex(base, dataCount, i)] as number,
      out,
      depth + 1,
      budget,
    );
  }
  return out;
}

export function hamtSize(arena: SharedArena, node: number, depth = 0): number {
  if (node === EMPTY_NODE) return 0;
  if (depth > MAX_DEPTH) {
    throw new ArenaCorruptError(`hamt traversal exceeded ${MAX_DEPTH} levels`, { offset: node });
  }
  const kind = readKind(arena, node);
  const base = node / WORD;
  if (kind === HAMT_COLLISION) return collisionCount(arena, node);
  const { dataCount, nodeCount } = bitmapLayout(arena, node);
  let total = dataCount;
  for (let i = 0; i < nodeCount; i += 1) {
    total += hamtSize(arena, arena.words[childIndex(base, dataCount, i)] as number, depth + 1);
  }
  return total;
}

/** Every node in the subtree, for retiring a whole structure the writer is discarding. */
export function hamtNodes(
  arena: SharedArena,
  node: number,
  out: number[] = [],
  depth = 0,
  budget = traversalBudget(arena),
): number[] {
  if (node === EMPTY_NODE) return out;
  if (depth > MAX_DEPTH) {
    throw new ArenaCorruptError(`hamt traversal exceeded ${MAX_DEPTH} levels`, { offset: node });
  }
  if (out.length > budget) {
    throw new ArenaCorruptError(
      `hamt traversal exceeded ${budget} nodes, which is more than the buffer can hold`,
      { offset: node },
    );
  }
  out.push(node);
  if (readKind(arena, node) === HAMT_COLLISION) return out;
  const base = node / WORD;
  const { dataCount, nodeCount } = bitmapLayout(arena, node);
  for (let i = 0; i < nodeCount; i += 1) {
    hamtNodes(
      arena,
      arena.words[childIndex(base, dataCount, i)] as number,
      out,
      depth + 1,
      budget,
    );
  }
  return out;
}

/** Property names of an object node, as strings. */
export function hamtKeyStrings(arena: SharedArena, node: number): string[] {
  return hamtEntries(arena, node).map((entry) => {
    if (entry.key.tag !== Tag.String) {
      throw new ArenaCorruptError("object key is not a string", { actual: entry.key.tag });
    }
    return decodeString(arena, entry.key.payload);
  });
}

/**
 * Look a string key up without interning it first.
 *
 * A reader cannot intern, because interning is a write, so it cannot compare keys by offset
 * the way the writer does. It can still walk the trie by hash and compare only the one
 * record it lands on, which is the same logarithmic walk with a character comparison at the
 * end instead of an integer one.
 */
export function hamtGetString(
  arena: SharedArena,
  node: number,
  text: string,
  hash: number,
): Slot | undefined {
  let current = node;
  let shift = 0;

  for (;;) {
    if (current === EMPTY_NODE) return undefined;
    const kind = readKind(arena, current);
    const base = current / WORD;

    if (kind === HAMT_COLLISION) {
      const count = collisionCount(arena, current);
      for (let i = 0; i < count; i += 1) {
        const at = dataIndex(base, i);
        if ((arena.words[at] as number) !== Tag.String) continue;
        if (!stringEquals(arena, arena.words[at + 1] as number, text)) continue;
        return { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number };
      }
      return undefined;
    }

    const { dataCount } = bitmapLayout(arena, current);
    const bit = 1 << fragment(hash, shift);
    const dataMap = arena.words[base + MAP_A] as number;
    const nodeMap = arena.words[base + MAP_B] as number;

    if ((dataMap & bit) !== 0) {
      const at = dataIndex(base, popcount(dataMap & (bit - 1)));
      if ((arena.words[at] as number) !== Tag.String) return undefined;
      if (!stringEquals(arena, arena.words[at + 1] as number, text)) return undefined;
      return { tag: arena.words[at + 2] as number, payload: arena.words[at + 3] as number };
    }

    if ((nodeMap & bit) === 0) return undefined;
    current = arena.words[
      childIndex(base, dataCount, popcount(nodeMap & (bit - 1)))
    ] as number;
    shift += BITS;
    if (shift > MAX_SHIFT + BITS) {
      throw new ArenaCorruptError("hamt lookup exceeded the maximum depth", { offset: node });
    }
  }
}
