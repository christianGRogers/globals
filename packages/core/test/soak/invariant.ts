/**
 * The soak invariant.
 *
 * The committed value is a pure function of the version id, so a reader can verify a
 * snapshot with no coordination at all. A mismatch means the root and the version id did not
 * come from the same commit, which is exactly the tearing the seqlock exists to prevent.
 *
 * The shape exercises every part of the object layer that reclamation has to get right:
 *
 *   a scalar field        a slot rewrite with no allocation
 *   a double field        a block that is allocated and later freed, so the free lists churn
 *   a pooled string       interning, which is append only and must settle rather than grow
 *   an array element      a vector path copy
 *   a nested object field a HAMT path copy two levels down
 *   a periodic wholesale replacement, which retires a whole structure at once
 */
export const STRING_POOL_SIZE = 64;
export const LIST_LENGTH = 16;

export interface SoakState {
  version: number;
  ratio: number;
  tag: string;
  list: number[];
  nested: { x: number; flag: boolean; label: string };
}

/** The state a given version must hold. */
export function expectedState(versionId: number): SoakState {
  return {
    version: versionId,
    ratio: versionId + 0.25,
    tag: `pooled-${versionId % STRING_POOL_SIZE}`,
    list: Array.from({ length: LIST_LENGTH }, (_unused, index) =>
      index === 0 ? versionId : index,
    ),
    nested: {
      x: versionId % 7,
      flag: versionId % 3 === 0,
      label: `label-${versionId % STRING_POOL_SIZE}`,
    },
  };
}

/** Every version whose id is a multiple of this replaces the root outright. */
export const WHOLESALE_EVERY = 512;

export interface Mismatch {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Check a decoded value against the version it claims to be.
 *
 * Returns the first mismatch rather than throwing, so a soak run reports a count instead of
 * dying on the first one.
 */
export function checkState(versionId: number, value: unknown): Mismatch | undefined {
  const expected = expectedState(versionId);
  if (value === null || typeof value !== "object") {
    return { field: "root", expected: "object", actual: typeof value };
  }
  const actual = value as SoakState;

  if (actual.version !== expected.version) {
    return { field: "version", expected: expected.version, actual: actual.version };
  }
  if (actual.ratio !== expected.ratio) {
    return { field: "ratio", expected: expected.ratio, actual: actual.ratio };
  }
  if (actual.tag !== expected.tag) {
    return { field: "tag", expected: expected.tag, actual: actual.tag };
  }
  if (actual.list?.[0] !== expected.list[0]) {
    return { field: "list[0]", expected: expected.list[0], actual: actual.list?.[0] };
  }
  if (actual.list?.length !== LIST_LENGTH) {
    return { field: "list.length", expected: LIST_LENGTH, actual: actual.list?.length };
  }
  if (actual.nested?.x !== expected.nested.x) {
    return { field: "nested.x", expected: expected.nested.x, actual: actual.nested?.x };
  }
  if (actual.nested?.label !== expected.nested.label) {
    return { field: "nested.label", expected: expected.nested.label, actual: actual.nested?.label };
  }
  return undefined;
}
