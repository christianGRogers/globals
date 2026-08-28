import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { ArenaCorruptError, GlobalsError } from "../src/errors.js";
import { Header, WORD } from "../src/layout.js";
import { Tag } from "../src/tags.js";
import { decodeValue } from "../src/values.js";

/**
 * Fail closed tests.
 *
 * Every case below is reachable in production, because any window that maps the arena can
 * write to any byte of it. The requirement is not that these produce a correct answer, it is
 * that they produce a typed error rather than a plausible looking value or a crash.
 */

function setup(): { owner: ArenaOwner; reader: ArenaReader } {
  const owner = ArenaOwner.create({
    byteLength: 1 << 18,
    maxByteLength: 1 << 20,
    maxReaders: 4,
    retainedVersions: 16,
  });
  return { owner, reader: ArenaReader.attach(owner.buffer) };
}

test("a root payload pointing outside the arena fails closed", () => {
  const { owner, reader } = setup();
  owner.commit(1.5);
  owner.arena.storeHeader(Header.RootPayload, 1 << 30);
  assert.throws(() => reader.read(), ArenaCorruptError);
  reader.detach();
});

test("a root payload pointing at the header fails closed", () => {
  const { owner, reader } = setup();
  owner.commit(1.5);
  owner.arena.storeHeader(Header.RootPayload, 8);
  // Rejected by the block header check, which runs before the range check and is the
  // stricter of the two: there is no room for a header that far down the buffer.
  assert.throws(() => reader.read(), /no room for a block header/);
  reader.detach();
});

test("an unaligned root payload fails closed", () => {
  const { owner, reader } = setup();
  owner.commit(1.5);
  owner.arena.storeHeader(Header.RootPayload, owner.arena.geometry.arenaOffset + 12);
  assert.throws(() => reader.read(), /not eight byte aligned/);
  reader.detach();
});

test("a root tag with no meaning fails closed", () => {
  const { owner, reader } = setup();
  owner.commit(1.5);
  owner.arena.storeHeader(Header.RootTag, 200);
  assert.throws(() => reader.read(), ArenaCorruptError);
  reader.detach();
});

test("a stomped block header is detected rather than trusted", () => {
  const { owner, reader } = setup();
  owner.commit(2.5);
  const payload = owner.arena.loadHeader(Header.RootPayload);
  // Overwrite the magic in the block header that precedes the payload.
  owner.arena.words[payload / WORD - 2] = 0;
  assert.throws(() => reader.read(), /no block header/);
  reader.detach();
});

test("a string with an impossible length is rejected", () => {
  const { owner, reader } = setup();
  owner.commit("short");
  const payload = owner.arena.loadHeader(Header.RootPayload);
  // Claim the string is far longer than the block that holds it.
  owner.arena.words[payload / WORD + 1] = 1 << 20;
  assert.throws(() => reader.read(), /does not fit/);
  reader.detach();
});

test("a negative string length is rejected", () => {
  const { owner, reader } = setup();
  owner.commit("short");
  const payload = owner.arena.loadHeader(Header.RootPayload);
  owner.arena.words[payload / WORD + 1] = -1;
  assert.throws(() => reader.read(), ArenaCorruptError);
  reader.detach();
});

test("sweeping a pointer slot across the whole buffer never returns a value", () => {
  const { owner } = setup();
  owner.commit(1.5);
  const arena = owner.arena;

  let decoded = 0;
  let typedErrors = 0;
  for (let offset = 0; offset < arena.byteLength; offset += 8) {
    try {
      decodeValue(arena, { tag: Tag.String, payload: offset });
      decoded += 1;
    } catch (error) {
      if (error instanceof GlobalsError) typedErrors += 1;
      else throw error;
    }
  }

  // Some offsets do land on real interned string records, which decode correctly. The
  // requirement is that everything else raises a typed error rather than an engine level
  // failure or a fabricated string.
  assert.ok(typedErrors > 0);
  assert.ok(decoded < 64, `too many offsets decoded as strings: ${decoded}`);
});

test("sweeping a double slot across the whole buffer never crashes", () => {
  const { owner } = setup();
  owner.commit(1.5);
  const arena = owner.arena;

  for (let offset = -64; offset < arena.byteLength + 64; offset += 8) {
    try {
      decodeValue(arena, { tag: Tag.Double, payload: offset });
    } catch (error) {
      assert.ok(error instanceof GlobalsError, `unexpected error type at ${offset}`);
    }
  }
});

test("every tag value, valid or not, is handled without an engine level failure", () => {
  const { owner } = setup();
  const arena = owner.arena;
  for (let tag = -8; tag < 300; tag += 1) {
    try {
      decodeValue(arena, { tag, payload: arena.geometry.arenaOffset });
    } catch (error) {
      assert.ok(error instanceof GlobalsError, `tag ${tag} produced ${String(error)}`);
    }
  }
});

test("a corrupt configuration header stops a new reader from attaching", () => {
  const { owner, reader } = setup();
  reader.detach();
  owner.arena.words[Header.RetainedRingOffset] = 64;
  assert.throws(() => ArenaReader.attach(owner.buffer), /configuration checksum/);
});
