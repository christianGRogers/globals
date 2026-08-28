/**
 * Every failure in this package is one of these. A decoder that cannot prove an offset is
 * valid throws rather than dereferencing it, which is the fail closed rule the trust model
 * depends on.
 */

/** Base class, so callers can catch every arena failure with one clause. */
export class GlobalsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The snapshot you are holding refers to a version the owner has reclaimed. This is the
 * expected outcome for a reader that stopped advancing while the writer ran past the
 * retention cap. Reacquire a snapshot.
 */
export class StaleSnapshotError extends GlobalsError {
  constructor(
    readonly versionId: number,
    readonly reclaimFloor: number,
  ) {
    super(
      `snapshot for version ${versionId} was reclaimed, the oldest retained version is ` +
        `${reclaimFloor}. Reacquire a snapshot.`,
    );
  }
}

/**
 * A read found something that cannot be produced by a correct writer: a bad offset, a
 * block header that does not match, a tag with no meaning. Treat this as a security event
 * as well as a bug, because any window mapping the arena can cause it.
 */
export class ArenaCorruptError extends GlobalsError {
  constructor(
    message: string,
    readonly detail: { offset?: number; expected?: number; actual?: number } = {},
  ) {
    super(message);
  }
}

/** The arena has no room and cannot grow further. */
export class ArenaFullError extends GlobalsError {
  constructor(
    readonly requestedBytes: number,
    readonly capacityBytes: number,
  ) {
    super(
      `cannot allocate ${requestedBytes} bytes, the arena capacity of ${capacityBytes} ` +
        "bytes is exhausted",
    );
  }
}

/** Every reader slot is claimed. Raise maxReaders, or find the reader that never released. */
export class NoReaderSlotError extends GlobalsError {
  constructor(readonly maxReaders: number) {
    super(`all ${maxReaders} reader slots are claimed`);
  }
}

/** A value was handed to the writer that the current type ladder cannot encode. */
export class UnencodableValueError extends GlobalsError {
  constructor(
    readonly value: unknown,
    readonly reason: string,
  ) {
    super(`cannot encode value: ${reason}`);
  }
}
