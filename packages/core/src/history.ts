import type { ArenaReader, Snapshot } from "./reader.js";
import { RetainedRing, type RetainedVersion } from "./retained.js";
import { StaleSnapshotError } from "./errors.js";

/**
 * Time travel over the retained version ring.
 *
 * The ring already holds the last N roots, because reclamation needs it to. Exposing it
 * costs nothing and answers the objection that decides adoption for a lot of people: an
 * opaque store is rejected regardless of how fast it is.
 *
 * What this is not: an undo stack. Retention is bounded, so history extends back exactly as
 * far as the ring and no further, and a version drops off the end without warning. An
 * application that needs durable undo should record its own operations.
 */

export interface HistoryEntry {
  readonly versionId: number;
  readonly rootTag: number;
  readonly rootPayload: number;
  /** True while the version can still be read. */
  readonly live: boolean;
}

export class VersionHistory {
  readonly #reader: ArenaReader;
  readonly #ring: RetainedRing;

  constructor(reader: ArenaReader) {
    this.#reader = reader;
    this.#ring = new RetainedRing(reader.arena);
  }

  /** Every version still retained, oldest first. */
  list(): HistoryEntry[] {
    return this.#ring.live().map((entry: RetainedVersion) => ({
      versionId: entry.versionId,
      rootTag: entry.rootTag,
      rootPayload: entry.rootPayload,
      live: true,
    }));
  }

  /** How far back history currently extends. */
  get depth(): number {
    return this.#ring.live().length;
  }

  /**
   * Read a retained version.
   *
   * The version is pinned for the duration of the call and released afterwards, so browsing
   * history does not hold memory the writer needs. That means the value is materialised
   * rather than returned as a lazy view: a view outliving its pin is exactly the bug the
   * validity checks exist to catch.
   */
  read(versionId: number): unknown {
    const entry = this.#ring.read(versionId);
    if (entry === undefined || !this.#ring.isLive(versionId)) {
      throw new StaleSnapshotError(versionId, this.#ring.reclaimFloor());
    }
    return this.#reader.readVersion(versionId);
  }

  /**
   * Pin a retained version and hand back a snapshot.
   *
   * The caller owns the pin and must release it. Holding one blocks reclamation of that
   * version and everything after it, which is exactly what a debugger wants and exactly what
   * a render loop must not do.
   */
  pin(versionId: number): Snapshot {
    return this.#reader.acquireVersion(versionId);
  }
}
