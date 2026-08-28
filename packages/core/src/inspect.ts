import type { ArenaOwner, OwnerStats } from "./owner.js";
import type { ArenaReader } from "./reader.js";
import { SIZE_CLASSES } from "./allocator.js";
import { RetainedRing } from "./retained.js";
import { ReaderTable } from "./readers.js";
import { Header } from "./layout.js";
import { tagName } from "./tags.js";

/**
 * Inspection.
 *
 * The loudest objection to a store like this is "I cannot see my state in DevTools", and it
 * decides adoption regardless of how fast the reads are. So this is a required deliverable
 * rather than a stretch goal, and it covers three things: values print as values, the arena
 * can be examined, and recent versions can be diffed.
 *
 * Values already print well, because every view implements `toJSON` and the object views are
 * proxies over plain shapes. What was missing is everything below the values, which is what
 * this module provides.
 */

export interface ArenaReport {
  readonly layoutVersion: number;
  readonly version: number;
  readonly reclaimFloor: number;
  readonly ownerGeneration: number;
  readonly capacityBytes: number;
  readonly usedBytes: number;
  readonly liveBytes: number;
  readonly freeListBytes: number;
  readonly strandedBytes: number;
  readonly utilisation: number;
  readonly internedStrings: number;
  readonly commits: number;
  readonly forcedAdvances: number;
  readonly retained: { versionId: number; rootTag: string }[];
  readonly readers: {
    slot: number;
    generation: number;
    epoch: number;
    heartbeat: number;
    lagVersions: number;
  }[];
}

/** A machine readable picture of the arena, for a debug panel or a log line. */
export function reportArena(owner: ArenaOwner): ArenaReport {
  const stats: OwnerStats = owner.stats();
  const ring = new RetainedRing(owner.arena);
  const table = new ReaderTable(owner.arena);
  const used = stats.bumpPointer - owner.arena.geometry.arenaOffset;

  return {
    layoutVersion: owner.arena.loadHeader(Header.LayoutVersion),
    version: stats.versionId,
    reclaimFloor: stats.reclaimFloor,
    ownerGeneration: owner.arena.ownerGeneration,
    capacityBytes: stats.capacityBytes,
    usedBytes: used,
    liveBytes: stats.liveBytes,
    freeListBytes: stats.freeListBytes,
    strandedBytes: stats.strandedBytes,
    utilisation: used === 0 ? 0 : stats.liveBytes / used,
    internedStrings: stats.internedStrings,
    commits: stats.commits,
    forcedAdvances: stats.forcedAdvances,
    retained: ring.live().map((entry) => ({
      versionId: entry.versionId,
      rootTag: tagName(entry.rootTag),
    })),
    readers: table.claimedSlots().map((reader) => ({
      slot: reader.slot,
      generation: reader.generation,
      epoch: reader.epoch,
      heartbeat: reader.heartbeat,
      lagVersions: reader.epoch === 0 ? 0 : stats.versionId - reader.epoch,
    })),
  };
}

/** The same picture as text, for a console or a bug report. */
export function formatArena(owner: ArenaOwner): string {
  const report = reportArena(owner);
  const lines = [
    `globals arena, layout ${report.layoutVersion}, owner generation ${report.ownerGeneration}`,
    ``,
    `  version           ${report.version}`,
    `  reclaim floor     ${report.reclaimFloor}`,
    `  commits           ${report.commits}`,
    `  forced advances   ${report.forcedAdvances}`,
    ``,
    `  capacity          ${bytes(report.capacityBytes)}`,
    `  used              ${bytes(report.usedBytes)}`,
    `  live              ${bytes(report.liveBytes)} (${(report.utilisation * 100).toFixed(1)}%)`,
    `  free lists        ${bytes(report.freeListBytes)}`,
    `  stranded          ${bytes(report.strandedBytes)}`,
    `  interned strings  ${report.internedStrings}`,
    ``,
    `  retained versions ${report.retained.length}` +
      (report.retained.length === 0
        ? ""
        : `, ${report.retained[0]?.versionId} to ${report.retained[report.retained.length - 1]?.versionId}`),
  ];

  if (report.readers.length === 0) {
    lines.push(`  readers           none attached`);
  } else {
    lines.push(`  readers`);
    for (const reader of report.readers) {
      const state = reader.epoch === 0 ? "idle" : `pinned at ${reader.epoch}, ${reader.lagVersions} behind`;
      lines.push(`    slot ${reader.slot} generation ${reader.generation}, ${state}`);
    }
  }

  if (report.strandedBytes > report.liveBytes) {
    lines.push(
      ``,
      `  note: stranded bytes exceed live bytes, which means blocks larger than the biggest`,
      `  size class (${SIZE_CLASSES[SIZE_CLASSES.length - 1]} bytes) are being freed and dropped rather than reused.`,
    );
  }

  return lines.join("\n");
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export interface ReaderReport {
  readonly slot: number;
  readonly generation: number;
  readonly pinnedEpoch: number;
  readonly publishedVersion: number;
  readonly reclaimFloor: number;
  readonly lagVersions: number;
  readonly headroomVersions: number;
}

/**
 * What a window can see about its own position.
 *
 * `headroomVersions` is the number this actually answers: how many more commits can happen
 * before this reader is force advanced and its snapshot fails closed. A window that keeps
 * seeing a small number here is not keeping up.
 */
export function reportReader(reader: ArenaReader): ReaderReport {
  const stats = reader.stats();
  const retained = new RetainedRing(reader.arena).capacity;
  const lag = stats.pinnedEpoch === 0 ? 0 : stats.publishedVersion - stats.pinnedEpoch;
  return {
    ...stats,
    lagVersions: lag,
    headroomVersions: stats.pinnedEpoch === 0 ? retained : retained - lag,
  };
}

/**
 * A shallow diff between two values, for a version to version view in a debug panel.
 *
 * Deliberately shallow and deliberately simple. A deep structural diff would duplicate what
 * the HAMT already knows, and comparing arena nodes by offset would be the right way to
 * build one later.
 */
export function diffShallow(
  before: unknown,
  after: unknown,
): { key: string; before: unknown; after: unknown }[] {
  const changes: { key: string; before: unknown; after: unknown }[] = [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object") {
    if (!Object.is(before, after)) changes.push({ key: "", before, after });
    return changes;
  }

  const keys = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ]);
  for (const key of keys) {
    const left = (before as Record<string, unknown>)[key];
    const right = (after as Record<string, unknown>)[key];
    if (!Object.is(left, right)) changes.push({ key, before: left, after: right });
  }
  return changes;
}
