import { readFile, rename, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Persistence.
 *
 * A hook on commit and a rehydrate path on boot, with the temp file and rename discipline
 * that makes a crash mid write leave either the old file or the new one, never half of
 * either.
 *
 * Writes are debounced and coalesced. A store committing a thousand times a second must not
 * produce a thousand disk writes, and the last one is the only one that matters.
 */

export interface PersistenceOptions {
  /** Where the snapshot lives. The directory is created if it does not exist. */
  file: string;
  /** Milliseconds to wait for further commits before writing. */
  debounceMs?: number;
  /** Serialise. Defaults to JSON with a version envelope. */
  serialise?: (value: unknown, version: number) => string;
  /** Parse. Defaults to the matching JSON envelope reader. */
  deserialise?: (text: string) => { value: unknown; version: number } | undefined;
  /** Called when a write or a read fails. Persistence must never take the app down. */
  onError?: (error: unknown, phase: "load" | "save") => void;
}

interface Envelope {
  readonly format: 1;
  readonly savedAt: string;
  readonly version: number;
  readonly value: unknown;
}

function defaultSerialise(value: unknown, version: number): string {
  const envelope: Envelope = {
    format: 1,
    savedAt: new Date().toISOString(),
    version,
    value,
  };
  return JSON.stringify(envelope);
}

function defaultDeserialise(text: string): { value: unknown; version: number } | undefined {
  const parsed = JSON.parse(text) as Partial<Envelope>;
  if (parsed === null || typeof parsed !== "object" || parsed.format !== 1) return undefined;
  return { value: parsed.value, version: typeof parsed.version === "number" ? parsed.version : 0 };
}

export class SnapshotStore {
  readonly #options: Required<Pick<PersistenceOptions, "file" | "debounceMs">> &
    PersistenceOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: { value: unknown; version: number } | undefined;
  #writing: Promise<void> = Promise.resolve();
  #writes = 0;

  constructor(options: PersistenceOptions) {
    this.#options = { debounceMs: 250, ...options };
  }

  get writeCount(): number {
    return this.#writes;
  }

  /**
   * Read the persisted value.
   *
   * A missing file is not an error: a first run has nothing to rehydrate. A corrupt file is
   * reported through onError and treated as missing, because refusing to start is a worse
   * outcome than starting empty.
   */
  async load(): Promise<{ value: unknown; version: number } | undefined> {
    try {
      const text = await readFile(this.#options.file, "utf8");
      const parse = this.#options.deserialise ?? defaultDeserialise;
      return parse(text);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") this.#options.onError?.(error, "load");
      return undefined;
    }
  }

  /** Queue a save. Coalesces with any save already queued. */
  save(value: unknown, version: number): void {
    this.#pending = { value, version };
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.debounceMs);
    this.#timer.unref?.();
  }

  /** Write whatever is queued now. Called on quit, and by tests. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) return this.#writing;

    // Serialise writes against each other. Two overlapping renames onto the same path is a
    // race with no upside.
    this.#writing = this.#writing.then(() => this.#write(pending.value, pending.version));
    return this.#writing;
  }

  async #write(value: unknown, version: number): Promise<void> {
    const serialise = this.#options.serialise ?? defaultSerialise;
    const target = this.#options.file;
    // The temp file sits beside the target so the rename stays on one filesystem. A rename
    // across devices is a copy, and a copy is not atomic.
    const temporary = join(dirname(target), `.${version}.${process.pid}.tmp`);

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, serialise(value, version), "utf8");
      await rename(temporary, target);
      this.#writes += 1;
    } catch (error) {
      this.#options.onError?.(error, "save");
      try {
        await unlink(temporary);
      } catch {
        // The temp file may not exist, which is the common case when writeFile is what
        // failed. Nothing to report.
      }
    }
  }
}
