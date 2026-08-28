import { ArenaCorruptError } from "./errors.js";
import {
  ALIGNMENT,
  BLOCK_CLASS_MASK,
  BLOCK_HEADER_BYTES,
  BLOCK_MAGIC,
  BLOCK_MAGIC_SHIFT,
  Block,
  CONFIG_WORDS,
  Header,
  LAYOUT_VERSION,
  MAGIC,
  WORD,
  computeGeometry,
  type ArenaGeometry,
} from "./layout.js";
import { hashWords } from "./checksum.js";

/**
 * A typed view over one shared buffer, plus the bounds checks that make every dereference
 * provably in range.
 *
 * Both the owner and every reader hold one of these. It carries no writer state, so it is
 * safe to construct in a process that must never mutate the arena.
 */
export class SharedArena {
  readonly buffer: SharedArrayBuffer;
  readonly geometry: ArenaGeometry;

  #i32: Int32Array;
  #f64: Float64Array;
  #u16: Uint16Array;
  #u8: Uint8Array;
  #byteLength: number;

  private constructor(buffer: SharedArrayBuffer, geometry: ArenaGeometry) {
    this.buffer = buffer;
    this.geometry = geometry;
    this.#i32 = new Int32Array(buffer);
    this.#f64 = new Float64Array(buffer);
    this.#u16 = new Uint16Array(buffer);
    this.#u8 = new Uint8Array(buffer);
    this.#byteLength = buffer.byteLength;
  }

  /**
   * Attach to a buffer an owner has already formatted. Validates the magic, the layout
   * version, and the configuration checksum, so a reader never starts decoding a buffer it
   * does not understand.
   */
  static attach(buffer: SharedArrayBuffer): SharedArena {
    if (buffer.byteLength < 128) {
      throw new ArenaCorruptError("buffer is too small to contain a header", {
        actual: buffer.byteLength,
      });
    }
    const words = new Int32Array(buffer);
    const magic = Atomics.load(words, Header.Magic);
    if (magic !== MAGIC) {
      throw new ArenaCorruptError("buffer does not carry the arena magic", {
        expected: MAGIC,
        actual: magic,
      });
    }
    const version = Atomics.load(words, Header.LayoutVersion);
    if (version !== LAYOUT_VERSION) {
      throw new ArenaCorruptError(
        `layout version ${version} cannot be read by a build expecting ${LAYOUT_VERSION}`,
        { expected: LAYOUT_VERSION, actual: version },
      );
    }
    const geometry = computeGeometry(
      Atomics.load(words, Header.MaxReaders),
      Atomics.load(words, Header.RetainedCapacity),
    );
    const arena = new SharedArena(buffer, geometry);
    arena.verifyConfigChecksum();
    return arena;
  }

  /** Format a fresh buffer. Only the owner calls this. */
  static format(
    buffer: SharedArrayBuffer,
    options: { maxReaders: number; retainedCapacity: number; flags: number },
  ): SharedArena {
    const geometry = computeGeometry(options.maxReaders, options.retainedCapacity);
    if (buffer.byteLength <= geometry.arenaOffset) {
      throw new ArenaCorruptError(
        `a buffer of ${buffer.byteLength} bytes cannot hold a header, a table for ` +
          `${options.maxReaders} readers, and a ring of ${options.retainedCapacity} versions`,
      );
    }
    const words = new Int32Array(buffer);
    words.fill(0);
    words[Header.Magic] = MAGIC;
    words[Header.LayoutVersion] = LAYOUT_VERSION;
    words[Header.CapacityBytes] = buffer.byteLength;
    words[Header.MaxReaders] = options.maxReaders;
    words[Header.ReaderTableOffset] = geometry.readerTableOffset;
    words[Header.RetainedRingOffset] = geometry.retainedRingOffset;
    words[Header.RetainedCapacity] = options.retainedCapacity;
    words[Header.ArenaOffset] = geometry.arenaOffset;
    words[Header.BumpPointer] = geometry.arenaOffset;
    words[Header.Flags] = options.flags;
    words[Header.OwnerGeneration] = 1;

    const arena = new SharedArena(buffer, geometry);
    arena.writeConfigChecksum();
    return arena;
  }

  /**
   * The cached views.
   *
   * These do not probe the buffer for growth. Probing here was measurably the most
   * expensive thing on the read path: reading `byteLength` from a growable
   * SharedArrayBuffer is not an inlined field load, and a single bounds checked decode
   * touches these accessors half a dozen times.
   *
   * Growth is picked up by `refresh()` instead, which callers invoke at the one point
   * where a longer view can matter: acquiring a version newer than the one they last saw.
   * Anything a reader decodes through a pinned version was allocated before that version
   * was published, so it is inside the view the reader had when it acquired.
   */
  get words(): Int32Array {
    return this.#i32;
  }

  get floats(): Float64Array {
    return this.#f64;
  }

  get units(): Uint16Array {
    return this.#u16;
  }

  get bytes(): Uint8Array {
    return this.#u8;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  #refreshIfGrown(): void {
    if (this.buffer.byteLength === this.#byteLength) return;
    this.#byteLength = this.buffer.byteLength;
    this.#i32 = new Int32Array(this.buffer);
    this.#f64 = new Float64Array(this.buffer);
    this.#u16 = new Uint16Array(this.buffer);
    this.#u8 = new Uint8Array(this.buffer);
  }

  /**
   * Header accessors read the cached view directly rather than going through the growth
   * check in `words`.
   *
   * That is safe because the header sits at offset zero and its size is fixed, so it is
   * inside every view this arena has ever had, including one made before a grow(). It is
   * also worth doing: a read touches the header eight times, and routing each of those
   * through a SharedArrayBuffer byteLength getter on a growable buffer cost more than the
   * rest of the read path put together.
   */
  loadHeader(field: number): number {
    return Atomics.load(this.#i32, field);
  }

  storeHeader(field: number, value: number): void {
    Atomics.store(this.#i32, field, value);
  }

  addHeader(field: number, delta: number): number {
    return Atomics.add(this.#i32, field, delta);
  }

  /**
   * Pick up a growth that another process performed. Callers that are about to read arena
   * payload, rather than only the header, call this once rather than paying for the check
   * on every access.
   */
  refresh(): void {
    this.#refreshIfGrown();
  }

  /** Bumped when a new owner adopts the buffer. A reader uses it to fail closed. */
  get ownerGeneration(): number {
    return Atomics.load(this.#i32, Header.OwnerGeneration);
  }

  writeConfigChecksum(): void {
    const words = this.words;
    words[Header.ConfigChecksum] = this.#configChecksum(words);
  }

  verifyConfigChecksum(): void {
    const words = this.words;
    const expected = this.#configChecksum(words);
    const actual = words[Header.ConfigChecksum] as number;
    if (expected !== actual) {
      throw new ArenaCorruptError("arena configuration checksum does not match", {
        expected,
        actual,
      });
    }
  }

  #configChecksum(words: Int32Array): number {
    const scratch = new Int32Array(CONFIG_WORDS.length);
    CONFIG_WORDS.forEach((field, index) => {
      scratch[index] = words[field] as number;
    });
    const hash = hashWords(scratch, 0, scratch.length);
    return hash === 0 ? 1 : hash;
  }

  /**
   * Prove that `byteCount` bytes at `offset` lie inside the arena region and are aligned.
   * Called before every dereference. A failure means the arena was written by something
   * that is not a correct writer.
   */
  checkRange(offset: number, byteCount: number, what: string): void {
    if (!Number.isInteger(offset) || offset < this.geometry.arenaOffset) {
      throw new ArenaCorruptError(`${what}: offset ${offset} is before the arena region`, {
        offset,
      });
    }
    if (offset % ALIGNMENT !== 0) {
      throw new ArenaCorruptError(`${what}: offset ${offset} is not eight byte aligned`, {
        offset,
      });
    }
    if (byteCount < 0 || offset + byteCount > this.byteLength) {
      throw new ArenaCorruptError(
        `${what}: ${byteCount} bytes at ${offset} run past the end of the buffer`,
        { offset, actual: this.byteLength },
      );
    }
  }

  /**
   * Validate the two word header preceding every allocation and return its payload size.
   * This is the check that turns a wild offset into a typed error rather than a plausible
   * looking value.
   */
  checkBlock(offset: number, what: string): number {
    if (!Number.isInteger(offset) || offset - BLOCK_HEADER_BYTES < this.geometry.arenaOffset) {
      throw new ArenaCorruptError(`${what}: no room for a block header at ${offset}`, { offset });
    }
    if (offset % ALIGNMENT !== 0) {
      throw new ArenaCorruptError(`${what}: offset ${offset} is not eight byte aligned`, {
        offset,
      });
    }
    const words = this.words;
    const base = offset / WORD;
    const headerWord = words[base + Block.Header] as number;
    if (headerWord >>> BLOCK_MAGIC_SHIFT !== BLOCK_MAGIC) {
      throw new ArenaCorruptError(`${what}: no block header at ${offset}`, {
        offset,
        expected: BLOCK_MAGIC,
        actual: headerWord >>> BLOCK_MAGIC_SHIFT,
      });
    }
    const byteSize = words[base + Block.ByteSize] as number;
    this.checkRange(offset, byteSize, what);
    return byteSize;
  }

  blockSizeClass(offset: number): number {
    const headerWord = this.words[offset / WORD + Block.Header] as number;
    return headerWord & BLOCK_CLASS_MASK;
  }
}
