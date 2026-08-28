/**
 * @globals/core
 *
 * The runtime agnostic core: one shared memory arena, a tagged value encoding, persistent
 * data structures, an allocator, and epoch based reclamation. Nothing here imports Electron,
 * so the arena can be exercised in plain Node with worker threads, which is how it is tested.
 *
 * The contract this package implements:
 *
 *   Reads are synchronous. A reader returns the current committed value on the line you call
 *   it, with no await and no round trip.
 *
 *   Writes are asynchronous. Only the owner writes, and every other process observes the
 *   result shortly after.
 */

export { SharedArena } from "./arena.js";
export { Allocator, SIZE_CLASSES } from "./allocator.js";
export type { AllocatorStats } from "./allocator.js";
export { ArenaOwner } from "./owner.js";
export type { OwnerOptions, OwnerStats } from "./owner.js";
export { ArenaReader, Snapshot } from "./reader.js";
export type { ReaderOptions, SnapshotInfo } from "./reader.js";
export { LivenessMonitor } from "./liveness.js";
export type { LivenessOptions } from "./liveness.js";
export { OwnerStore, ReaderStore } from "./store.js";
export type { ReadableStore, WritableStore } from "./store.js";
export { ReaderTable } from "./readers.js";
export { RetainedRing } from "./retained.js";
export type { RetainedVersion } from "./retained.js";
export { StringTable, decodeString, stringEquals, stringHash } from "./strings.js";
export { Tag, tagName, isKnownTag } from "./tags.js";
export type { TagValue } from "./tags.js";
export { ExternalRef, ExternalTier } from "./external.js";
export type { ExternalTransport } from "./external.js";
export {
  TYPED_ARRAY_KINDS,
  collectBlocks,
  containerSize,
  decodeValue,
  encodeValue,
} from "./values.js";
export type { EncodeContext, Slot, TypedArrayKind } from "./values.js";
export { createDraft, finalizeState } from "./draft.js";
export type { DraftContext, DraftNode } from "./draft.js";
export { isView, readPath, viewSlot, viewValue } from "./view.js";
export type { ViewContext } from "./view.js";
export {
  EMPTY_NODE,
  hamtEntries,
  hamtGet,
  hamtGetString,
  hamtSize,
  keyEquals,
  keyHash,
} from "./hamt.js";
export type { HamtContext, HamtEntry } from "./hamt.js";
export {
  EMPTY_VECTOR,
  vectorAssoc,
  vectorFromSlots,
  vectorGet,
  vectorLength,
  vectorPush,
  vectorSlots,
} from "./vector.js";
export type { VectorContext, VectorHeader } from "./vector.js";
export {
  ArenaCorruptError,
  ArenaFullError,
  GlobalsError,
  NoReaderSlotError,
  StaleSnapshotError,
  UnencodableValueError,
} from "./errors.js";
export { LAYOUT_VERSION, RetainedState, VerifyMode, computeGeometry } from "./layout.js";
export type { ArenaGeometry, VerifyModeValue } from "./layout.js";
