import type { SharedArena } from "./arena.js";
import type { Allocator } from "./allocator.js";
import type { StringTable } from "./strings.js";
import { decodeString } from "./strings.js";
import { ArenaCorruptError, UnencodableValueError } from "./errors.js";
import { Tag, isKnownTag, payloadIsOffset, tagName } from "./tags.js";

/** A tagged eight byte slot, as a pair of 32 bit words. */
export interface Slot {
  readonly tag: number;
  readonly payload: number;
}

export const UNDEFINED_SLOT: Slot = { tag: Tag.Undefined, payload: 0 };
export const NULL_SLOT: Slot = { tag: Tag.Null, payload: 0 };

/** What an encoder needs. The object layer widens this without changing the shape. */
export interface EncodeContext {
  readonly arena: SharedArena;
  readonly allocator: Allocator;
  readonly strings: StringTable;
  /** Blocks the encoder allocated, so a failed commit can release them. */
  readonly allocated: number[];
}

function isInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

/**
 * Encode a value into a slot.
 *
 * The type ladder in phase 1 is the scalar rung: number, string, boolean, null, and
 * undefined. Anything else raises UnencodableValueError, which is the boundary the
 * asynchronous tier exists to cover. The object layer extends this function rather than
 * replacing it, so the scalar cases stay on the shortest path.
 */
export function encodeValue(context: EncodeContext, value: unknown): Slot {
  switch (typeof value) {
    case "undefined":
      return UNDEFINED_SLOT;

    case "boolean":
      return { tag: value ? Tag.True : Tag.False, payload: 0 };

    case "number": {
      // Negative zero has to take the double path. Encoded as an int32 it would read back
      // as positive zero, and Object.is would disagree with the value that went in.
      if (isInt32(value) && !Object.is(value, -0)) {
        return { tag: Tag.Int32, payload: value };
      }
      const offset = context.allocator.allocate(8);
      context.allocated.push(offset);
      context.arena.floats[offset / 8] = value;
      return { tag: Tag.Double, payload: offset };
    }

    case "string":
      // Interned, so the offset may be one the table already held and must not be added to
      // the allocated list: releasing it would free a record other versions still use.
      return { tag: Tag.String, payload: context.strings.intern(value) };

    case "object":
      if (value === null) return NULL_SLOT;
      throw new UnencodableValueError(
        value,
        "objects and arrays need the object layer, which arrives in phase 2",
      );

    case "bigint":
      throw new UnencodableValueError(value, "bigint is on the phase 2 type ladder");

    case "symbol":
      throw new UnencodableValueError(value, "symbols have no cross process identity");

    case "function":
      throw new UnencodableValueError(value, "functions cannot cross a process boundary");

    default:
      throw new UnencodableValueError(value, `unsupported typeof result ${typeof value}`);
  }
}

/**
 * Decode a slot.
 *
 * Every branch that dereferences an offset validates it first, through checkBlock or
 * checkRange. That is not defensive programming for its own sake: any window that maps the
 * arena can write a slot, so a wild offset is a reachable state rather than a bug that
 * cannot happen.
 */
export function decodeValue(arena: SharedArena, slot: Slot): unknown {
  const { tag, payload } = slot;

  if (!isKnownTag(tag)) {
    throw new ArenaCorruptError(`slot carries an unknown tag ${tag}`, { actual: tag });
  }

  switch (tag) {
    case Tag.Undefined:
      return undefined;
    case Tag.Null:
      return null;
    case Tag.False:
      return false;
    case Tag.True:
      return true;
    case Tag.Int32:
      return payload;
    case Tag.Double: {
      arena.checkBlock(payload, "double");
      return arena.floats[payload / 8];
    }
    case Tag.String:
      return decodeString(arena, payload);
    default:
      throw new ArenaCorruptError(
        `tag ${tagName(tag)} is not decodable by this build, the object layer is required`,
        { actual: tag },
      );
  }
}

/**
 * Blocks that become garbage when a slot stops being referenced.
 *
 * Interned strings are deliberately absent: they are shared between versions and are freed
 * only when the arena is discarded. See the note in strings.ts.
 */
export function retiredBlocks(slot: Slot): number[] {
  if (slot.tag === Tag.Double && payloadIsOffset(slot.tag)) return [slot.payload];
  return [];
}
