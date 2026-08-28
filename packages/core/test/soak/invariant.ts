/**
 * The soak invariant.
 *
 * The committed value is a pure function of the version id, so a reader can verify a
 * snapshot with no coordination at all. A mismatch means the root tag, the root payload,
 * and the version id did not come from the same commit, which is exactly the tearing the
 * seqlock exists to prevent.
 *
 * Three shapes, cycled, so the workload exercises the three encoding paths that matter:
 *
 *   int32   stays in the slot, allocates nothing
 *   double  allocates and later frees an eight byte block, so the free lists churn
 *   string  interns from a bounded pool, so the string table settles rather than growing
 */
export const STRING_POOL_SIZE = 64;

export function expectedValueFor(versionId: number): unknown {
  // Version 1 is the empty root the owner commits when it formats the arena.
  if (versionId <= 1) return undefined;
  switch (versionId % 3) {
    case 0:
      return versionId;
    case 1:
      return versionId + 0.25;
    default:
      return `pooled-${versionId % STRING_POOL_SIZE}`;
  }
}
