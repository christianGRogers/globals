/**
 * The shared memory layout.
 *
 * Everything here is a fixed offset agreed between the owner and every reader. A change to
 * any of it is a breaking change to the wire format and requires a LAYOUT_VERSION bump,
 * because an owner and a reader from different builds may map the same buffer.
 *
 * Byte map:
 *
 *   0                    header, HEADER_BYTES
 *   HEADER_BYTES         reader table, maxReaders * READER_SLOT_BYTES
 *   ...                  retained version ring, retainedCap * RETAINED_SLOT_BYTES
 *   ...                  arena, grows upward from a bump pointer
 */

/** "GLOB" in ASCII. A buffer that does not start with this is not one of ours. */
export const MAGIC = 0x474c4f42;

/** Bump on any change to the byte map, the block header, or the tag meanings. */
export const LAYOUT_VERSION = 1;

export const WORD = 4;
export const SLOT_BYTES = 8;
/** Every allocation starts on an eight byte boundary so float64 stores are aligned. */
export const ALIGNMENT = 8;

// ---------------------------------------------------------------------------
// Header, in 32 bit words
// ---------------------------------------------------------------------------

export const Header = {
  Magic: 0,
  LayoutVersion: 1,
  /** Total byte length the owner believes the buffer has. Updated on grow. */
  CapacityBytes: 2,
  /** Guards the configuration words, so a reader can detect a stomped header. */
  ConfigChecksum: 3,
  /**
   * Seqlock over the root publication. Even means stable, odd means a commit is in
   * progress. Readers retry rather than block.
   */
  Sequence: 4,
  RootTag: 5,
  RootPayload: 6,
  /** Monotonic. Doubles as the epoch a reader pins. */
  VersionId: 7,
  /** Byte offset of the next unallocated byte. */
  BumpPointer: 8,
  MaxReaders: 9,
  ReaderTableOffset: 10,
  RetainedRingOffset: 11,
  RetainedCapacity: 12,
  ArenaOffset: 13,
  /** Oldest version still retained. A snapshot below this is stale. */
  ReclaimFloor: 14,
  /** Verification mode, see VerifyMode. */
  Flags: 15,
  /** Bumped by the owner on every liveness tick so readers can detect a dead owner. */
  OwnerHeartbeat: 16,
  /** Bumped when a new owner adopts the buffer, so stale readers fail closed. */
  OwnerGeneration: 17,
  StatCommits: 18,
  StatBytesAllocated: 19,
  StatBytesFreed: 20,
  StatBytesLive: 21,
  StatForcedAdvances: 22,
  /** Checksum over the header and the current root, when verification is on. */
  RootChecksum: 23,
} as const;

export const HEADER_WORDS = 32;
export const HEADER_BYTES = HEADER_WORDS * WORD;

/** Words the ConfigChecksum covers. These never change after creation. */
export const CONFIG_WORDS = [
  Header.Magic,
  Header.LayoutVersion,
  Header.MaxReaders,
  Header.ReaderTableOffset,
  Header.RetainedRingOffset,
  Header.RetainedCapacity,
  Header.ArenaOffset,
] as const;

// ---------------------------------------------------------------------------
// Reader table
// ---------------------------------------------------------------------------

export const ReaderSlot = {
  /** 0 free, 1 claimed. Claimed with compareExchange so two readers cannot share a slot. */
  State: 0,
  /** Bumped on each claim. A snapshot from an earlier generation is not valid. */
  Generation: 1,
  /** The version this reader is pinned to. Zero means it is not reading. */
  Epoch: 2,
  /** Monotonic counter the reader bumps. A stalled counter means a dead or frozen reader. */
  Heartbeat: 3,
} as const;

export const READER_SLOT_WORDS = 4;
export const READER_SLOT_BYTES = READER_SLOT_WORDS * WORD;

export const SLOT_FREE = 0;
export const SLOT_CLAIMED = 1;

// ---------------------------------------------------------------------------
// Retained version ring
// ---------------------------------------------------------------------------

export const RetainedSlot = {
  VersionId: 0,
  RootTag: 1,
  RootPayload: 2,
  /** See RetainedState. */
  State: 3,
} as const;

export const RETAINED_SLOT_WORDS = 4;
export const RETAINED_SLOT_BYTES = RETAINED_SLOT_WORDS * WORD;

export const RetainedState = {
  Empty: 0,
  /** Readers may pin this version. */
  Live: 1,
  /** Reclaimed normally, every reader had moved past it. */
  Reclaimed: 2,
  /** Reclaimed while a reader was still pinned, because retention hit its cap. */
  ForceReclaimed: 3,
} as const;

// ---------------------------------------------------------------------------
// Allocation block header
// ---------------------------------------------------------------------------

/**
 * Every allocation is preceded by two words. The magic makes a wild offset detectable
 * instead of merely wrong, and the size class lets the allocator return the block to the
 * right free list without a side table.
 */
export const Block = {
  /** BLOCK_MAGIC in the high 24 bits, size class index in the low 8. */
  Header: -2,
  /** Payload bytes, not counting this header. */
  ByteSize: -1,
} as const;

export const BLOCK_HEADER_BYTES = 8;
export const BLOCK_MAGIC = 0x424c4b; // "BLK"
export const BLOCK_MAGIC_SHIFT = 8;
export const BLOCK_CLASS_MASK = 0xff;
/** Size class 255 means the block was allocated at an exact size and has no free list. */
export const SIZE_CLASS_EXACT = 0xff;

export const VerifyMode = {
  Off: 0,
  Header: 1,
  Full: 2,
} as const;

export type VerifyModeValue = (typeof VerifyMode)[keyof typeof VerifyMode];

// ---------------------------------------------------------------------------
// Derived layout
// ---------------------------------------------------------------------------

export interface ArenaGeometry {
  readonly maxReaders: number;
  readonly retainedCapacity: number;
  readonly readerTableOffset: number;
  readonly retainedRingOffset: number;
  readonly arenaOffset: number;
}

export function computeGeometry(maxReaders: number, retainedCapacity: number): ArenaGeometry {
  const readerTableOffset = HEADER_BYTES;
  const retainedRingOffset = readerTableOffset + maxReaders * READER_SLOT_BYTES;
  const arenaOffset = align(retainedRingOffset + retainedCapacity * RETAINED_SLOT_BYTES);
  return { maxReaders, retainedCapacity, readerTableOffset, retainedRingOffset, arenaOffset };
}

export function align(bytes: number): number {
  return (bytes + (ALIGNMENT - 1)) & ~(ALIGNMENT - 1);
}
