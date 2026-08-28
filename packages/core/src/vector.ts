import type { SharedArena } from "./arena.js";
import type { Allocator } from "./allocator.js";
import { ArenaCorruptError } from "./errors.js";
import { SLOT_BYTES, WORD } from "./layout.js";
import type { Slot } from "./values.js";

/**
 * A chunked persistent vector, the array counterpart to the HAMT.
 *
 * A 32 way trie with a tail buffer, which is the structure Clojure uses. Appending is
 * amortised constant time because it lands in the tail, and setting an index copies one path
 * of at most seven nodes rather than the whole array.
 *
 * Header layout, at the payload offset the allocator returns:
 *
 *   word 0  magic
 *   word 1  count, the total element count including the tail
 *   word 2  shift, five times the trie depth above the leaves
 *   word 3  root node offset, zero when the trie is empty
 *   word 4  tail node offset, zero when the tail is empty
 *
 * Internal node: word 0 child count, then that many child offsets.
 * Leaf node:     word 0 slot count, then that many slots of two words each.
 */

export const VECTOR_MAGIC = 0x56454300;
const NODE_MAGIC = 0x564e4400;
const LEAF_MAGIC = 0x564c4600;

const BITS = 5;
const WIDTH = 1 << BITS;
const MASK = WIDTH - 1;

const H_MAGIC = 0;
const H_COUNT = 1;
const H_SHIFT = 2;
const H_ROOT = 3;
const H_TAIL = 4;
const HEADER_WORDS = 5;

export const EMPTY_VECTOR = 0;

export interface VectorContext {
  readonly arena: SharedArena;
  readonly allocator: Allocator;
  /** Nodes replaced on the copied path. The commit retires them. */
  readonly retired: number[];
  /** Every block this operation allocated, so a rejected write can release them. */
  readonly allocated: number[];
}

export interface VectorHeader {
  readonly count: number;
  readonly shift: number;
  readonly root: number;
  readonly tail: number;
  readonly tailOffset: number;
}

export function readHeader(arena: SharedArena, vector: number): VectorHeader {
  const byteSize = arena.checkBlock(vector, "vector header");
  if (byteSize < HEADER_WORDS * WORD) {
    throw new ArenaCorruptError(`vector header at ${vector} is too small`, { offset: vector });
  }
  const base = vector / WORD;
  if ((arena.words[base + H_MAGIC] as number) !== VECTOR_MAGIC) {
    throw new ArenaCorruptError(`no vector header at ${vector}`, { offset: vector });
  }
  const count = arena.words[base + H_COUNT] as number;
  const shift = arena.words[base + H_SHIFT] as number;
  // Every element occupies at least one eight byte slot somewhere, so a count larger than the
  // buffer can hold is impossible. Without this bound a corrupted count sends the decoder off
  // to build an array of two billion elements, which takes the process down rather than
  // failing closed. The fuzzer found this by crashing V8.
  const impossibleCount = count < 0 || count > arena.byteLength / SLOT_BYTES;
  if (impossibleCount || shift < 0 || shift > 30) {
    throw new ArenaCorruptError(
      `vector at ${vector} has an impossible count ${count} or shift ${shift}`,
      { offset: vector },
    );
  }
  const tailLength = count === 0 ? 0 : ((count - 1) % WIDTH) + 1;
  return {
    count,
    shift,
    root: arena.words[base + H_ROOT] as number,
    tail: arena.words[base + H_TAIL] as number,
    tailOffset: count - tailLength,
  };
}

function leafCount(arena: SharedArena, leaf: number): number {
  const byteSize = arena.checkBlock(leaf, "vector leaf");
  const count = arena.words[leaf / WORD + 1] as number;
  if ((arena.words[leaf / WORD] as number) !== LEAF_MAGIC) {
    throw new ArenaCorruptError(`no vector leaf at ${leaf}`, { offset: leaf });
  }
  if (count < 0 || count > WIDTH || (2 + count * 2) * WORD > byteSize) {
    throw new ArenaCorruptError(`vector leaf at ${leaf} claims ${count} slots`, { offset: leaf });
  }
  return count;
}

function nodeCount(arena: SharedArena, node: number): number {
  const byteSize = arena.checkBlock(node, "vector node");
  const count = arena.words[node / WORD + 1] as number;
  if ((arena.words[node / WORD] as number) !== NODE_MAGIC) {
    throw new ArenaCorruptError(`no vector node at ${node}`, { offset: node });
  }
  if (count < 0 || count > WIDTH || (2 + count) * WORD > byteSize) {
    throw new ArenaCorruptError(`vector node at ${node} claims ${count} children`, {
      offset: node,
    });
  }
  return count;
}

function allocLeaf(context: VectorContext, count: number): number {
  const offset = context.allocator.allocate((2 + count * 2) * WORD);
  context.allocated.push(offset);
  const words = context.arena.words;
  words[offset / WORD] = LEAF_MAGIC;
  words[offset / WORD + 1] = count;
  return offset;
}

function allocNode(context: VectorContext, count: number): number {
  const offset = context.allocator.allocate((2 + count) * WORD);
  context.allocated.push(offset);
  const words = context.arena.words;
  words[offset / WORD] = NODE_MAGIC;
  words[offset / WORD + 1] = count;
  return offset;
}

function allocHeader(
  context: VectorContext,
  count: number,
  shift: number,
  root: number,
  tail: number,
): number {
  const offset = context.allocator.allocate(HEADER_WORDS * WORD);
  context.allocated.push(offset);
  const words = context.arena.words;
  const base = offset / WORD;
  words[base + H_MAGIC] = VECTOR_MAGIC;
  words[base + H_COUNT] = count;
  words[base + H_SHIFT] = shift;
  words[base + H_ROOT] = root;
  words[base + H_TAIL] = tail;
  return offset;
}

function leafSlot(arena: SharedArena, leaf: number, index: number): Slot {
  const base = leaf / WORD + 2 + index * 2;
  return { tag: arena.words[base] as number, payload: arena.words[base + 1] as number };
}

function writeLeafSlot(arena: SharedArena, leaf: number, index: number, slot: Slot): void {
  const base = leaf / WORD + 2 + index * 2;
  arena.words[base] = slot.tag;
  arena.words[base + 1] = slot.payload;
}

function childAt(arena: SharedArena, node: number, index: number): number {
  return arena.words[node / WORD + 2 + index] as number;
}

/** The leaf that holds `index`, following the trie down from the root. */
function leafFor(arena: SharedArena, header: VectorHeader, index: number): number {
  if (index >= header.tailOffset) return header.tail;
  let node = header.root;
  for (let shift = header.shift; shift > 0; shift -= BITS) {
    const slot = (index >>> shift) & MASK;
    const count = nodeCount(arena, node);
    if (slot >= count) {
      throw new ArenaCorruptError(`vector index ${index} walks off a node`, { offset: node });
    }
    node = childAt(arena, node, slot);
  }
  return node;
}

export function vectorGet(arena: SharedArena, vector: number, index: number): Slot | undefined {
  if (vector === EMPTY_VECTOR) return undefined;
  const header = readHeader(arena, vector);
  if (!Number.isInteger(index) || index < 0 || index >= header.count) return undefined;
  const leaf = leafFor(arena, header, index);
  const count = leafCount(arena, leaf);
  const within = index & MASK;
  if (within >= count) {
    throw new ArenaCorruptError(`vector leaf is shorter than index ${index} requires`, {
      offset: leaf,
    });
  }
  return leafSlot(arena, leaf, within);
}

export function vectorLength(arena: SharedArena, vector: number): number {
  if (vector === EMPTY_VECTOR) return 0;
  return readHeader(arena, vector).count;
}

export function emptyVector(context: VectorContext): number {
  return allocHeader(context, 0, BITS, 0, 0);
}

function copyLeafWith(
  context: VectorContext,
  leaf: number,
  index: number,
  slot: Slot,
): number {
  const arena = context.arena;
  const count = leafCount(arena, leaf);
  const created = allocLeaf(context, count);
  for (let i = 0; i < count; i += 1) {
    writeLeafSlot(arena, created, i, i === index ? slot : leafSlot(arena, leaf, i));
  }
  context.retired.push(leaf);
  return created;
}

function assocInTrie(
  context: VectorContext,
  node: number,
  shift: number,
  index: number,
  slot: Slot,
): number {
  const arena = context.arena;
  if (shift === 0) return copyLeafWith(context, node, index & MASK, slot);

  const count = nodeCount(arena, node);
  const childIndex = (index >>> shift) & MASK;
  const child = childAt(arena, node, childIndex);
  const newChild = assocInTrie(context, child, shift - BITS, index, slot);

  const created = allocNode(context, count);
  for (let i = 0; i < count; i += 1) {
    arena.words[created / WORD + 2 + i] = i === childIndex ? newChild : childAt(arena, node, i);
  }
  context.retired.push(node);
  return created;
}

/** Replace one element. Copies the path to it and nothing else. */
export function vectorAssoc(
  context: VectorContext,
  vector: number,
  index: number,
  slot: Slot,
): number {
  const arena = context.arena;
  const header = readHeader(arena, vector);
  if (!Number.isInteger(index) || index < 0 || index >= header.count) {
    throw new RangeError(`index ${index} is outside a vector of length ${header.count}`);
  }

  if (index >= header.tailOffset) {
    const tail = copyLeafWith(context, header.tail, index - header.tailOffset, slot);
    const created = allocHeader(context, header.count, header.shift, header.root, tail);
    context.retired.push(vector);
    return created;
  }

  const root = assocInTrie(context, header.root, header.shift, index, slot);
  const created = allocHeader(context, header.count, header.shift, root, header.tail);
  context.retired.push(vector);
  return created;
}

function newPath(context: VectorContext, shift: number, leaf: number): number {
  if (shift === 0) return leaf;
  const node = allocNode(context, 1);
  context.arena.words[node / WORD + 2] = newPath(context, shift - BITS, leaf);
  return node;
}

function pushLeaf(
  context: VectorContext,
  node: number,
  shift: number,
  count: number,
  leaf: number,
): number {
  const arena = context.arena;
  const childIndex = ((count - 1) >>> shift) & MASK;
  const existing = nodeCount(arena, node);

  if (shift === BITS) {
    const created = allocNode(context, Math.max(existing, childIndex + 1));
    for (let i = 0; i < existing; i += 1) {
      arena.words[created / WORD + 2 + i] = childAt(arena, node, i);
    }
    arena.words[created / WORD + 2 + childIndex] = leaf;
    context.retired.push(node);
    return created;
  }

  const created = allocNode(context, Math.max(existing, childIndex + 1));
  for (let i = 0; i < existing; i += 1) {
    arena.words[created / WORD + 2 + i] = childAt(arena, node, i);
  }
  arena.words[created / WORD + 2 + childIndex] =
    childIndex < existing
      ? pushLeaf(context, childAt(arena, node, childIndex), shift - BITS, count, leaf)
      : newPath(context, shift - BITS, leaf);
  context.retired.push(node);
  return created;
}

/** Append one element. Amortised constant time, because it usually lands in the tail. */
export function vectorPush(context: VectorContext, vector: number, slot: Slot): number {
  const arena = context.arena;
  const header = readHeader(arena, vector);
  const tailLength = header.count - header.tailOffset;

  if (header.count === 0) {
    const tail = allocLeaf(context, 1);
    writeLeafSlot(arena, tail, 0, slot);
    const created = allocHeader(context, 1, BITS, 0, tail);
    context.retired.push(vector);
    return created;
  }

  if (tailLength < WIDTH) {
    const tail = allocLeaf(context, tailLength + 1);
    for (let i = 0; i < tailLength; i += 1) {
      writeLeafSlot(arena, tail, i, leafSlot(arena, header.tail, i));
    }
    writeLeafSlot(arena, tail, tailLength, slot);
    context.retired.push(header.tail);
    const created = allocHeader(context, header.count + 1, header.shift, header.root, tail);
    context.retired.push(vector);
    return created;
  }

  // The tail is full, so it becomes a leaf in the trie and a fresh tail starts.
  const newTail = allocLeaf(context, 1);
  writeLeafSlot(arena, newTail, 0, slot);

  let root: number;
  let shift = header.shift;
  if (header.root === 0) {
    root = header.tail;
    shift = BITS;
    // A one leaf trie is addressed with shift zero at the root.
    const created = allocHeader(context, header.count + 1, 0, root, newTail);
    context.retired.push(vector);
    return created;
  }

  const overflow = header.count >>> BITS > 1 << header.shift;
  if (overflow) {
    root = allocNode(context, 2);
    arena.words[root / WORD + 2] = header.root;
    arena.words[root / WORD + 3] = newPath(context, header.shift, header.tail);
    shift = header.shift + BITS;
  } else {
    root = pushLeaf(context, header.root, header.shift, header.count, header.tail);
  }

  const created = allocHeader(context, header.count + 1, shift, root, newTail);
  context.retired.push(vector);
  return created;
}

/** Every slot in order. Used by eager decoding and by rebuilds. */
export function vectorSlots(arena: SharedArena, vector: number): Slot[] {
  if (vector === EMPTY_VECTOR) return [];
  const header = readHeader(arena, vector);
  const out: Slot[] = [];
  for (let i = 0; i < header.count; i += 1) {
    const slot = vectorGet(arena, vector, i);
    if (slot === undefined) {
      throw new ArenaCorruptError(`vector reports ${header.count} elements but index ${i} is absent`);
    }
    out.push(slot);
  }
  return out;
}

/**
 * Build a vector from slots, bottom up.
 *
 * Used for array literals and for the operations that cannot be expressed as a path copy,
 * such as splice and sort.
 *
 * Built in one pass rather than by repeated push. Pushing N elements copies the tail leaf on
 * every call and allocates a header each time, so building a twenty thousand element array
 * that way churned megabytes of intermediate blocks and could exhaust an arena that had
 * ample room for the result. This allocates the leaves once, the internal nodes once, and one
 * header.
 */
export function vectorFromSlots(context: VectorContext, slots: readonly Slot[]): number {
  const arena = context.arena;
  const count = slots.length;
  if (count === 0) return emptyVector(context);

  // The tail holds the last partial chunk, or a full one when the count divides evenly.
  const tailLength = ((count - 1) % WIDTH) + 1;
  const trieCount = count - tailLength;

  const tail = allocLeaf(context, tailLength);
  for (let i = 0; i < tailLength; i += 1) {
    writeLeafSlot(arena, tail, i, slots[trieCount + i] as Slot);
  }

  if (trieCount === 0) return allocHeader(context, count, 0, 0, tail);

  let level: number[] = [];
  for (let start = 0; start < trieCount; start += WIDTH) {
    const leaf = allocLeaf(context, WIDTH);
    for (let i = 0; i < WIDTH; i += 1) {
      writeLeafSlot(arena, leaf, i, slots[start + i] as Slot);
    }
    level.push(leaf);
  }

  // A single leaf is addressed with shift zero, so the depth only starts counting once there
  // is an internal node above it.
  let shift = 0;
  while (level.length > 1) {
    const parents: number[] = [];
    for (let start = 0; start < level.length; start += WIDTH) {
      const children = level.slice(start, start + WIDTH);
      const node = allocNode(context, children.length);
      for (let i = 0; i < children.length; i += 1) {
        arena.words[node / WORD + 2 + i] = children[i] as number;
      }
      parents.push(node);
    }
    level = parents;
    shift += BITS;
  }

  return allocHeader(context, count, shift, level[0] as number, tail);
}

/** Every node making up a vector, for retiring a structure the writer is discarding. */
export function vectorNodes(arena: SharedArena, vector: number, out: number[] = []): number[] {
  if (vector === EMPTY_VECTOR) return out;
  const header = readHeader(arena, vector);
  out.push(vector);
  if (header.tail !== 0) out.push(header.tail);
  // A node needs at least three words, so the buffer cannot hold more than this many however
  // a corrupt trie is arranged. Without the bound, a child pointing back at an ancestor fans
  // out inside the shift bound and exhausts the heap.
  const budget = Math.ceil(arena.byteLength / 12);
  if (header.root !== 0) collectTrie(arena, header.root, header.shift, out, budget);
  return out;
}

function collectTrie(
  arena: SharedArena,
  node: number,
  shift: number,
  out: number[],
  budget: number,
): void {
  if (shift < 0) {
    throw new ArenaCorruptError("vector trie walk went below the leaf level", { offset: node });
  }
  if (out.length > budget) {
    throw new ArenaCorruptError(
      `vector walk exceeded ${budget} nodes, which is more than the buffer can hold`,
      { offset: node },
    );
  }
  out.push(node);
  if (shift === 0) return;
  const count = nodeCount(arena, node);
  for (let i = 0; i < count; i += 1) {
    collectTrie(arena, childAt(arena, node, i), shift - BITS, out, budget);
  }
}
