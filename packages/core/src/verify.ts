import type { SharedArena } from "./arena.js";
import { Header, VerifyMode, type VerifyModeValue } from "./layout.js";
import { HASH_SEED, mixWord } from "./checksum.js";
import { Tag } from "./tags.js";
import { WORD } from "./layout.js";
import { hamtEntries } from "./hamt.js";
import { vectorSlots } from "./vector.js";
import type { Slot } from "./values.js";
import { ArenaCorruptError } from "./errors.js";

/**
 * Verified reads.
 *
 * The trust model says a shared buffer is writable by everything that maps it, and that no
 * amount of engineering removes that. What a checksum does buy is detection: a window that
 * corrupts the arena through a bug, or a hostile window that does not also forge the
 * checksum, is caught before a reader decodes what it wrote.
 *
 * What it does not buy, stated here as plainly as in the documentation, is protection from a
 * window that computes a valid checksum for corrupt data. That window has exactly the
 * information the owner has. This is a corruption detector, not a message authentication
 * code, and calling it one would be a lie a security reviewer would catch.
 *
 * Cost is per version, not per read. The owner computes it once on commit and a reader
 * verifies once when it acquires a new version, so a render loop that reads the same version
 * a hundred times pays once.
 */

/** Words covered by the header checksum. The root, the version, and the geometry. */
const COVERED = [
  Header.Magic,
  Header.LayoutVersion,
  Header.RootTag,
  Header.RootPayload,
  Header.VersionId,
  Header.MaxReaders,
  Header.ReaderTableOffset,
  Header.RetainedRingOffset,
  Header.RetainedCapacity,
  Header.ArenaOffset,
  Header.OwnerGeneration,
] as const;

// Deliberately not covered: the reclaim floor, the bump pointer, and the statistics. All
// three move independently of the root, the floor within the very commit that publishes the
// checksum, so covering them would make every version fail verification.

export function verifyMode(arena: SharedArena): VerifyModeValue {
  const flags = arena.loadHeader(Header.Flags) & 0b11;
  return flags as VerifyModeValue;
}

/**
 * The header checksum, over the root and the geometry.
 *
 * Deliberately not over the bump pointer or the statistics, which move independently of the
 * root and would make every reader recompute for no reason.
 */
export function headerChecksum(arena: SharedArena, root: Slot, versionId: number): number {
  const words = arena.words;
  let hash = HASH_SEED;
  for (const field of COVERED) {
    if (field === Header.RootTag) {
      hash = mixWord(hash, root.tag);
      continue;
    }
    if (field === Header.RootPayload) {
      hash = mixWord(hash, root.payload);
      continue;
    }
    if (field === Header.VersionId) {
      hash = mixWord(hash, versionId);
      continue;
    }
    hash = mixWord(hash, words[field] as number);
  }
  return hash === 0 ? 1 : hash;
}

/**
 * A checksum over everything reachable from a root.
 *
 * Linear in the size of the structure, so it is a diagnostic mode rather than a production
 * one. It catches corruption of a leaf value deep in the tree, which the header checksum
 * cannot see at all.
 *
 * The walk is bounded by the same block header validation every decode uses, so a corrupted
 * arena makes this throw rather than loop.
 */
export function deepChecksum(arena: SharedArena, root: Slot, budget = 2_000_000): number {
  let hash = HASH_SEED;
  let visited = 0;

  const walk = (slot: Slot): void => {
    visited += 1;
    if (visited > budget) {
      throw new ArenaCorruptError(
        `the reachable set exceeded ${budget} nodes, which means a cycle or a corrupt offset`,
      );
    }
    hash = mixWord(hash, slot.tag);

    switch (slot.tag) {
      case Tag.Undefined:
      case Tag.Null:
      case Tag.False:
      case Tag.True:
        return;
      case Tag.Int32:
        hash = mixWord(hash, slot.payload);
        return;
      case Tag.Double:
      case Tag.Date: {
        arena.checkBlock(slot.payload, "verify double");
        const base = slot.payload / WORD;
        hash = mixWord(hash, arena.words[base] as number);
        hash = mixWord(hash, arena.words[base + 1] as number);
        return;
      }
      case Tag.String:
      case Tag.RegExp:
      case Tag.BigInt:
      case Tag.TypedArray: {
        const size = arena.checkBlock(slot.payload, "verify record");
        const base = slot.payload / WORD;
        for (let i = 0; i < size / WORD; i += 1) {
          hash = mixWord(hash, arena.words[base + i] as number);
        }
        return;
      }
      case Tag.Object:
      case Tag.Map:
      case Tag.Set: {
        for (const entry of hamtEntries(arena, slot.payload)) {
          walk(entry.key);
          walk(entry.value);
        }
        return;
      }
      case Tag.Array: {
        for (const element of vectorSlots(arena, slot.payload)) walk(element);
        return;
      }
      case Tag.External:
        hash = mixWord(hash, slot.payload);
        return;
      default:
        throw new ArenaCorruptError(`verify found an unknown tag ${slot.tag}`, {
          actual: slot.tag,
        });
    }
  };

  walk(root);
  return hash === 0 ? 1 : hash;
}

/** Owner side. Compute and publish the checksum for a version. */
export function publishChecksum(
  arena: SharedArena,
  root: Slot,
  versionId: number,
  mode: VerifyModeValue,
): void {
  if (mode === VerifyMode.Off) {
    arena.storeHeader(Header.RootChecksum, 0);
    return;
  }
  const header = headerChecksum(arena, root, versionId);
  const value = mode === VerifyMode.Full ? mixWord(header, deepChecksum(arena, root)) : header;
  arena.storeHeader(Header.RootChecksum, value === 0 ? 1 : value);
}

/**
 * Reader side. Throw when the published checksum does not match the root it belongs to.
 *
 * The published checksum is a parameter rather than something this function loads, and that
 * is not tidiness. It has to be read inside the seqlock window alongside the root and the
 * version, or the writer can commit between the seqlock check and the checksum load, and the
 * reader compares a checksum from one version against a root from another. That produced a
 * steady trickle of false corruption reports under load, roughly fifty in eight hundred
 * thousand reads, which is exactly the shape of bug that looks like flakiness.
 *
 * Called once per version rather than once per read.
 */
export function verifyRoot(
  arena: SharedArena,
  root: Slot,
  versionId: number,
  published: number,
): void {
  const mode = verifyMode(arena);
  if (mode === VerifyMode.Off) return;

  const header = headerChecksum(arena, root, versionId);
  const expected = mode === VerifyMode.Full ? mixWord(header, deepChecksum(arena, root)) : header;
  const normalised = expected === 0 ? 1 : expected;

  if (published !== normalised) {
    throw new ArenaCorruptError(
      `version ${versionId} does not match its published checksum. Something wrote to the ` +
        "arena that is not the owner. Treat this as a security event as well as a bug.",
      { expected: normalised, actual: published },
    );
  }
}
