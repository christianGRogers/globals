import type { SharedArena } from "./arena.js";
import { ArenaFullError } from "./errors.js";
import {
  BLOCK_HEADER_BYTES,
  BLOCK_MAGIC,
  BLOCK_MAGIC_SHIFT,
  Block,
  Header,
  SIZE_CLASS_EXACT,
  WORD,
  align,
} from "./layout.js";

/**
 * Size class slabs above a bump region.
 *
 * Sizes are payload bytes, not counting the eight byte block header. They double roughly
 * every two steps, which caps internal waste at about 25 percent while keeping the class
 * count small enough that the lookup is a short scan rather than a division.
 */
export const SIZE_CLASSES = [
  8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096,
] as const;

const MAX_CLASS_BYTES = SIZE_CLASSES[SIZE_CLASSES.length - 1] as number;

function classForSize(bytes: number): number {
  for (let index = 0; index < SIZE_CLASSES.length; index += 1) {
    if (bytes <= (SIZE_CLASSES[index] as number)) return index;
  }
  return SIZE_CLASS_EXACT;
}

export interface AllocatorStats {
  readonly bumpPointer: number;
  readonly capacityBytes: number;
  readonly liveBytes: number;
  readonly freeListBytes: number;
  readonly allocations: number;
  readonly frees: number;
  readonly headerBytes: number;
}

/**
 * The allocator runs only in the owner. That is the single biggest simplification in the
 * design: there is exactly one writer, so no allocator structure needs a lock, and the free
 * lists can live on the owner heap rather than in shared memory where a hostile window
 * could corrupt them.
 *
 * Defend that property. Any feature that introduces a second writer costs a lock on every
 * allocation, and the read path pays for it indirectly through longer commits.
 */
export class Allocator {
  readonly #arena: SharedArena;
  /** One free list per size class, holding payload offsets of freed blocks. */
  readonly #freeLists: number[][] = SIZE_CLASSES.map(() => []);
  #liveBytes = 0;
  #freeListBytes = 0;
  /** Block header bytes consumed by bump allocation. Overhead, never reusable. */
  #headerBytes = 0;
  #allocations = 0;
  #frees = 0;
  #grow: ((minimumBytes: number) => boolean) | undefined;

  constructor(arena: SharedArena, grow?: (minimumBytes: number) => boolean) {
    this.#arena = arena;
    this.#grow = grow;
  }

  /**
   * Allocate `byteSize` payload bytes and return the payload offset. The returned block is
   * eight byte aligned and preceded by a validated header.
   *
   * The contents are not zeroed. Callers write every byte they later read, and the block
   * header check plus the record specific length field is what makes a partially written
   * block undecodable rather than plausible.
   */
  allocate(byteSize: number): number {
    if (byteSize <= 0) throw new RangeError(`allocation size must be positive, got ${byteSize}`);

    const sizeClass = classForSize(byteSize);
    const blockBytes = sizeClass === SIZE_CLASS_EXACT
      ? align(byteSize)
      : (SIZE_CLASSES[sizeClass] as number);

    if (sizeClass !== SIZE_CLASS_EXACT) {
      const reused = (this.#freeLists[sizeClass] as number[]).pop();
      if (reused !== undefined) {
        this.#freeListBytes -= blockBytes;
        this.#liveBytes += blockBytes;
        this.#allocations += 1;
        this.#writeBlockHeader(reused, sizeClass, blockBytes);
        return reused;
      }
    }

    return this.#bumpAllocate(blockBytes, sizeClass);
  }

  /**
   * Return a block to its free list. Blocks larger than the largest size class are dropped
   * rather than tracked, because a mixed size free list degrades into a first fit search
   * and this allocator is not the place to pay for that. Phase 5 measures whether real
   * workloads produce enough of them to need compaction.
   */
  free(offset: number): void {
    const byteSize = this.#arena.checkBlock(offset, "free");
    const sizeClass = this.#arena.blockSizeClass(offset);
    this.#liveBytes -= byteSize;
    this.#frees += 1;

    if (sizeClass === SIZE_CLASS_EXACT) return;
    (this.#freeLists[sizeClass] as number[]).push(offset);
    this.#freeListBytes += byteSize;
  }

  stats(): AllocatorStats {
    return {
      bumpPointer: this.#arena.loadHeader(Header.BumpPointer),
      capacityBytes: this.#arena.byteLength,
      liveBytes: this.#liveBytes,
      freeListBytes: this.#freeListBytes,
      allocations: this.#allocations,
      frees: this.#frees,
      headerBytes: this.#headerBytes,
    };
  }

  /**
   * Bytes consumed from the arena that are neither live nor reusable.
   *
   * Block headers are excluded because they are fixed overhead rather than fragmentation.
   * What remains is the blocks that were allocated at an exact size, freed, and dropped
   * rather than tracked. A number that climbs with time is the signal that compaction is
   * needed, which is the phase 5 question.
   */
  strandedBytes(): number {
    const bump = this.#arena.loadHeader(Header.BumpPointer);
    const used = bump - this.#arena.geometry.arenaOffset;
    return used - this.#liveBytes - this.#freeListBytes - this.#headerBytes;
  }

  #bumpAllocate(blockBytes: number, sizeClass: number): number {
    const arena = this.#arena;
    const bump = arena.loadHeader(Header.BumpPointer);
    const payloadOffset = bump + BLOCK_HEADER_BYTES;
    const nextBump = payloadOffset + blockBytes;

    if (nextBump > arena.byteLength) {
      const needed = nextBump - arena.byteLength;
      if (!this.#grow?.(needed)) {
        throw new ArenaFullError(blockBytes + BLOCK_HEADER_BYTES, arena.byteLength);
      }
      // Growth succeeded, so the bump pointer is still valid and the buffer is longer.
      // Views do not track growth on their own, so pick up the longer one before retrying.
      arena.refresh();
      return this.#bumpAllocate(blockBytes, sizeClass);
    }

    arena.storeHeader(Header.BumpPointer, nextBump);
    this.#headerBytes += BLOCK_HEADER_BYTES;
    arena.storeHeader(Header.CapacityBytes, arena.byteLength);
    this.#writeBlockHeader(payloadOffset, sizeClass, blockBytes);
    this.#liveBytes += blockBytes;
    this.#allocations += 1;
    return payloadOffset;
  }

  #writeBlockHeader(payloadOffset: number, sizeClass: number, blockBytes: number): void {
    const words = this.#arena.words;
    const base = payloadOffset / WORD;
    words[base + Block.Header] = (BLOCK_MAGIC << BLOCK_MAGIC_SHIFT) | (sizeClass & 0xff);
    words[base + Block.ByteSize] = blockBytes;
  }
}

export { MAX_CLASS_BYTES, classForSize };
