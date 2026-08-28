import { test } from "node:test";
import assert from "node:assert/strict";

import { SharedArena } from "../src/arena.js";
import { Allocator } from "../src/allocator.js";
import { StringTable } from "../src/strings.js";
import { decodeValue, encodeValue, type EncodeContext } from "../src/values.js";
import { UnencodableValueError, ArenaCorruptError } from "../src/errors.js";
import { Tag } from "../src/tags.js";

function context(bytes = 1 << 18): EncodeContext {
  const arena = SharedArena.format(new SharedArrayBuffer(bytes), {
    maxReaders: 4,
    retainedCapacity: 8,
    flags: 0,
  });
  const allocator = new Allocator(arena);
  return { arena, allocator, strings: new StringTable(arena, allocator), allocated: [] };
}

function roundTrip(value: unknown, ctx = context()): unknown {
  return decodeValue(ctx.arena, encodeValue(ctx, value));
}

test("scalars round trip identically", () => {
  const ctx = context();
  const cases = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    -1,
    2147483647,
    -2147483648,
    2147483648,
    -2147483649,
    0.1,
    -0.5,
    1e300,
    5e-324,
    Number.MAX_SAFE_INTEGER,
    "",
    "hello",
    "a longer string with spaces and punctuation, plus digits 12345",
  ];
  for (const value of cases) {
    assert.deepEqual(roundTrip(value, ctx), value, `failed for ${String(value)}`);
  }
});

test("negative zero survives, because Object.is has to agree", () => {
  assert.ok(Object.is(roundTrip(-0), -0));
});

test("NaN and the infinities survive", () => {
  const ctx = context();
  assert.ok(Number.isNaN(roundTrip(Number.NaN, ctx) as number));
  assert.equal(roundTrip(Number.POSITIVE_INFINITY, ctx), Number.POSITIVE_INFINITY);
  assert.equal(roundTrip(Number.NEGATIVE_INFINITY, ctx), Number.NEGATIVE_INFINITY);
});

test("integers in the int32 range stay in the slot and allocate nothing", () => {
  const ctx = context();
  const before = ctx.allocator.stats().allocations;
  const slot = encodeValue(ctx, 1234);
  assert.equal(slot.tag, Tag.Int32);
  assert.equal(slot.payload, 1234);
  assert.equal(ctx.allocator.stats().allocations, before);
});

test("numbers outside the int32 range take the double path", () => {
  const ctx = context();
  const slot = encodeValue(ctx, 2 ** 40);
  assert.equal(slot.tag, Tag.Double);
  assert.equal(decodeValue(ctx.arena, slot), 2 ** 40);
});

test("strings with astral characters and lone surrogates round trip", () => {
  const ctx = context();
  for (const value of ["\u{1F600} emoji", "\uD800 lone high surrogate", "\uDC00 lone low"]) {
    assert.equal(roundTrip(value, ctx), value);
  }
});

test("a long string round trips through the chunked decode path", () => {
  const ctx = context(1 << 22);
  const value = "x".repeat(50_000);
  assert.equal(roundTrip(value, ctx), value);
});

test("equal strings intern to one record", () => {
  const ctx = context();
  const first = encodeValue(ctx, "shared key");
  const second = encodeValue(ctx, "shared key");
  assert.equal(first.payload, second.payload);
  assert.equal(ctx.strings.size, 1);
});

test("values outside the phase 1 ladder raise a typed error naming the reason", () => {
  const ctx = context();
  assert.throws(() => encodeValue(ctx, {}), UnencodableValueError);
  assert.throws(() => encodeValue(ctx, [1, 2]), UnencodableValueError);
  assert.throws(() => encodeValue(ctx, 1n), UnencodableValueError);
  assert.throws(() => encodeValue(ctx, Symbol("s")), UnencodableValueError);
  assert.throws(() => encodeValue(ctx, () => 0), UnencodableValueError);
});

test("an unknown tag is rejected rather than guessed at", () => {
  const ctx = context();
  assert.throws(() => decodeValue(ctx.arena, { tag: 99, payload: 0 }), ArenaCorruptError);
});

test("a random offset in a pointer slot fails closed", () => {
  const ctx = context();
  const arenaStart = ctx.arena.geometry.arenaOffset;
  for (const payload of [0, 8, arenaStart, arenaStart + 4096, 1 << 30, -8]) {
    assert.throws(
      () => decodeValue(ctx.arena, { tag: Tag.Double, payload }),
      ArenaCorruptError,
      `offset ${payload} should not have decoded`,
    );
  }
});

test("property: a thousand random scalars round trip", () => {
  const ctx = context(1 << 22);
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 2 ** 32;
  };

  for (let i = 0; i < 1000; i += 1) {
    const pick = Math.floor(next() * 5);
    let value: unknown;
    if (pick === 0) value = Math.floor(next() * 2 ** 32) - 2 ** 31;
    else if (pick === 1) value = next() * 1e12 - 5e11;
    else if (pick === 2) value = next() < 0.5;
    else if (pick === 3) value = next() < 0.5 ? null : undefined;
    else value = `s${Math.floor(next() * 1e9).toString(36)}`;

    const decoded = roundTrip(value, ctx);
    assert.ok(Object.is(decoded, value), `round trip changed ${String(value)}`);
  }
});
