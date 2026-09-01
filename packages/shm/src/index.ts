/**
 * The native transport, typed.
 *
 * One process creates a region and owns it: only that handle may flush. Any process may
 * attach and sync. A flush copies the owner's dirty ranges into the mapping inside one
 * seqlock section; a sync produces a copy of the whole data region that is guaranteed to be
 * a single commit, never a torn mixture, and returns the version that copy belongs to. The
 * version is the commit count: zero means no commit has ever been flushed, and a reader
 * treats a version 0 region as empty rather than decoding it.
 *
 * Every byte a reader decodes comes from its own buffer, so nothing downstream of sync ever
 * touches shared memory, and nothing here ever wraps the mapping in an ArrayBuffer. That is
 * the contract that keeps the V8 memory cage out of the picture; see
 * spikes/08-mmap-accessor/README.md for the measurements behind the design.
 */
import { createRequire } from "node:module";

interface NativeAddon {
  create(path: string, dataSize: number): unknown;
  attach(path: string): unknown;
  close(handle: unknown): void;
  dataSize(handle: unknown): number;
  version(handle: unknown): number;
  flush(handle: unknown, src: Uint8Array, ranges: Uint32Array): number;
  sync(handle: unknown, dest: Uint8Array): number;
  stats(handle: unknown): { dataSize: number; version: number; owner: boolean };
  LAYOUT_VERSION: number;
}

const require_ = createRequire(import.meta.url);

/**
 * The C library this process runs against, when that distinction matters.
 *
 * It matters on Linux and nowhere else. A prebuild named only for platform and
 * architecture claims to serve every Linux, and a glibc binary loaded on Alpine fails at
 * the dynamic linker rather than falling through to a build that would have worked. Node
 * reports the runtime glibc version it linked against, and reports nothing there when it
 * did not link against one, which is what musl looks like from here.
 */
export function libcSuffix(): string {
  if (process.platform !== "linux") return "";
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    return report?.header?.glibcVersionRuntime === undefined ? "-musl" : "";
  } catch {
    // A runtime that will not describe itself is treated as the common case rather than
    // refused: the load below still has to succeed on its own merits.
    return "";
  }
}

function loadAddon(): NativeAddon {
  // A shipped package carries prebuilds per platform and architecture; a working tree
  // carries whatever node-gyp last built. The prebuild wins so that installing never
  // needs a toolchain, and the local build remains the fallback for development.
  //
  // On a libc the prebuilds do not cover, the local build is not a fallback, it is the
  // only route, and the install script is what puts it there.
  const target = `${process.platform}-${process.arch}`;
  const suffix = libcSuffix();
  const candidates = [
    ...(suffix === "" ? [] : [`../../native/prebuilds/${target}${suffix}/globals_shm.node`]),
    // A musl runtime must never reach the unsuffixed prebuild: it is a glibc binary, and
    // loading it fails in a way that reads like a broken package rather than a missing one.
    ...(suffix === "" ? [`../../native/prebuilds/${target}/globals_shm.node`] : []),
    "../../native/build/Release/globals_shm.node",
  ];
  let cause: unknown;
  for (const candidate of candidates) {
    try {
      return require_(candidate) as NativeAddon;
    } catch (error) {
      cause = error;
    }
  }
  throw new Error(
    `the @bradensbay/globals-shm native addon is not available for ${target}${suffix}, and it could not be built from source on install. ` +
      `Building it needs a C toolchain: Python 3 and a compiler (build-essential on Debian, base-devel on Alpine, Xcode command line tools on macOS, Visual Studio Build Tools on Windows). ` +
      `With one installed, reinstalling this package will compile it.`,
    { cause },
  );
}

const addon = loadAddon();

/** The region layout this build reads and writes. A mismatch refuses to attach. */
export const LAYOUT_VERSION: number = addon.LAYOUT_VERSION;

/** One dirty range of a commit: byte offset into the region, byte length. */
export type FlushRange = readonly [offset: number, length: number];

function packRanges(dataSize: number, ranges: readonly FlushRange[] | undefined): Uint32Array {
  if (ranges === undefined) return Uint32Array.of(0, dataSize);
  const packed = new Uint32Array(ranges.length * 2);
  for (let i = 0; i < ranges.length; i++) {
    packed[i * 2] = ranges[i][0];
    packed[i * 2 + 1] = ranges[i][1];
  }
  return packed;
}

/** The writing side. Exactly one owner exists per region: the process that created it. */
export class OwnerRegion {
  #handle: unknown;
  readonly path: string;
  readonly dataSize: number;

  private constructor(handle: unknown, path: string, dataSize: number) {
    this.#handle = handle;
    this.path = path;
    this.dataSize = dataSize;
  }

  /** Creates (or re-initialises) the region file and maps it as the owner. */
  static create(path: string, dataSize: number): OwnerRegion {
    const handle = addon.create(path, dataSize);
    return new OwnerRegion(handle, path, dataSize);
  }

  /**
   * Publishes one commit: copies the given ranges of `src` into the region under the
   * seqlock and bumps the version. With no ranges given, the whole region is flushed.
   * `src` is the owner's private mirror of the data region, so offsets are shared between
   * the two. Returns the new version.
   */
  flush(src: Uint8Array, ranges?: readonly FlushRange[]): number {
    return addon.flush(this.#handle, src, packRanges(this.dataSize, ranges));
  }

  /** The current version: the number of commits ever flushed. */
  version(): number {
    return addon.version(this.#handle);
  }

  close(): void {
    addon.close(this.#handle);
  }
}

/** The reading side. Any process may attach; none of them may write. */
export class ReaderRegion {
  #handle: unknown;
  readonly path: string;
  readonly dataSize: number;

  private constructor(handle: unknown, path: string, dataSize: number) {
    this.#handle = handle;
    this.path = path;
    this.dataSize = dataSize;
  }

  /** Attaches to an existing region, refusing files that are not regions or use a layout this build does not understand. */
  static attach(path: string): ReaderRegion {
    const handle = addon.attach(path);
    return new ReaderRegion(handle, path, addon.dataSize(handle));
  }

  /**
   * The current version, one native call. The intended fast path: check this against the
   * version of the copy already held, and sync only when it moved.
   */
  version(): number {
    return addon.version(this.#handle);
  }

  /**
   * Copies the whole data region into `dest` as one consistent commit and returns the
   * version that copy belongs to. `dest` must be at least `dataSize` bytes.
   */
  sync(dest: Uint8Array): number {
    return addon.sync(this.#handle, dest);
  }

  close(): void {
    addon.close(this.#handle);
  }
}
