import { test } from "node:test";
import assert from "node:assert/strict";

import { ArenaOwner } from "../src/owner.js";
import { ArenaReader } from "../src/reader.js";
import { ArenaCorruptError, GlobalsError, StaleSnapshotError } from "../src/errors.js";
import { Header, VerifyMode, WORD, type VerifyModeValue } from "../src/layout.js";
import { HAMT_COLLISION } from "../src/hamt.js";
import { VECTOR_MAGIC } from "../src/vector.js";
import { Tag } from "../src/tags.js";
import { decodeValue } from "../src/values.js";

/**
 * Fail closed tests.
 *
 * Every case below is reachable in production, because any window that maps the arena can
 * write to any byte of it. The requirement is not that these produce a correct answer, it is
 * that they produce a typed error rather than a plausible looking value or a crash.
 */

/**
 * Verification is off for most of these.
 *
 * With it on, the checksum catches header tampering before a decoder ever runs, which is the
 * point of it but would leave the decode paths untested. These tests are about the second
 * line of defence: what happens when something corrupts the arena and the checksum does not
 * catch it, which is exactly the case the trust model says is possible.
 */
function setup(verify: VerifyModeValue = VerifyMode.Off): { owner: ArenaOwner; reader: ArenaReader } {
  const owner = ArenaOwner.create({
    byteLength: 1 << 18,
    maxByteLength: 1 << 20,
    maxReaders: 4,
    retainedVersions: 16,
    verify,
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

test("verification catches a tampered root when a reader acquires it", () => {
  const { owner, reader } = setup(VerifyMode.Header);
  owner.commit({ balance: 100 });
  assert.equal((reader.acquire().toJSON() as { balance: number }).balance, 100);
  reader.detach();

  // A window rewrites the root payload to point somewhere else. Without verification the
  // next reader would decode whatever is there.
  // Move the root somewhere it demonstrably is not. Picking a fixed offset would risk
  // landing on the real root, which is how this test first passed for the wrong reason.
  owner.arena.storeHeader(
    Header.RootPayload,
    owner.arena.loadHeader(Header.RootPayload) + 4096,
  );

  const fresh = ArenaReader.attach(owner.buffer);
  assert.throws(() => fresh.acquire(), /published checksum/);
  fresh.detach();
});

test("verification is per version, not per read, and the limit is deliberate", () => {
  const { owner, reader } = setup(VerifyMode.Header);
  owner.commit({ balance: 100 });
  const snapshot = reader.acquire();

  // Move the root somewhere it demonstrably is not. Picking a fixed offset would risk
  // landing on the real root, which is how this test first passed for the wrong reason.
  owner.arena.storeHeader(
    Header.RootPayload,
    owner.arena.loadHeader(Header.RootPayload) + 4096,
  );

  // The reader already verified this version and holds it. It does not verify again, which
  // is what makes verification affordable: a render loop reading the same version a hundred
  // times pays once. Corruption after acquisition is caught at the next acquisition, not
  // before, and the documentation says so rather than implying continuous protection.
  assert.equal(snapshot.versionId, owner.versionId);
  assert.doesNotThrow(() => reader.acquire());
  reader.detach();
});

test("verification catches a rewritten owner generation", () => {
  const { owner, reader } = setup(VerifyMode.Header);
  owner.commit({ a: 1 });
  reader.detach();

  // The generation is covered by the checksum and is invisible to every other guard, so
  // this is the case only verification catches.
  owner.arena.storeHeader(Header.OwnerGeneration, 77);

  const fresh = ArenaReader.attach(owner.buffer);
  assert.throws(() => fresh.acquire(), /published checksum/);
  fresh.detach();
});

test("a rewritten version id fails closed through the retained ring", () => {
  const { owner, reader } = setup(VerifyMode.Header);
  owner.commit({ a: 1 });
  reader.detach();

  owner.arena.storeHeader(Header.VersionId, 999_999);

  // Caught before the checksum gets a chance: the ring has no live entry for that version,
  // so the reader retries and then reports a stale snapshot. Two guards, and the earlier one
  // wins. Both are fail closed, which is the property that matters.
  const fresh = ArenaReader.attach(owner.buffer);
  assert.throws(() => fresh.acquire(), StaleSnapshotError);
  fresh.detach();
});

test("full verification catches a leaf value the header checksum cannot see", () => {
  const { owner, reader } = setup(VerifyMode.Full);
  owner.commit({ nested: { balance: 100 } });
  assert.deepEqual(reader.acquire().toJSON(), { nested: { balance: 100 } });
  reader.detach();

  // Stomp a value deep inside the structure. The root pointer is untouched, so a header
  // checksum would pass this and only the full mode can see it.
  const words = owner.arena.words;
  let changed = false;
  for (let index = owner.arena.geometry.arenaOffset / WORD; index < words.length; index += 1) {
    if (words[index] === 100) {
      words[index] = 999;
      changed = true;
      break;
    }
  }
  assert.equal(changed, true, "the test needs to find the value it stomps");

  const fresh = ArenaReader.attach(owner.buffer);
  assert.throws(() => fresh.acquire(), /published checksum/);
  fresh.detach();
});

test("verification off means no checksum is published, and reads still work", () => {
  const { owner, reader } = setup(VerifyMode.Off);
  owner.commit({ a: 1 });
  assert.equal(owner.arena.loadHeader(Header.RootChecksum), 0);
  assert.deepEqual(reader.acquire().toJSON(), { a: 1 });
  reader.detach();
});

/**
 * Regressions from the fuzzer.
 *
 * Each of these was found by corrupting a real arena at random. They are kept as named tests
 * because a fuzz run is probabilistic and a regression should fail immediately rather than
 * eventually.
 */

test("a collision node with an impossible entry count is rejected", () => {
  const { owner, reader } = setup(VerifyMode.Off);

  // Build a set, which is a trie whose nodes can become collision nodes, then find one and
  // lie about how many entries it holds. Before this check, every walker trusted the count
  // and went off to visit two billion entries with no bound inside the loop.
  owner.commit({ members: new Set(["a", "b", "c", "d", "e"]) });

  const words = owner.arena.words;
  const start = owner.arena.geometry.arenaOffset / WORD;
  let patched = false;
  for (let index = start; index < words.length; index += 1) {
    if (words[index] === HAMT_COLLISION) {
      words[index + 1] = 2_000_000_000;
      patched = true;
      break;
    }
  }

  if (!patched) {
    // Five short strings may not collide, so forge a collision node over a real block rather
    // than skipping the check entirely.
    const payload = owner.arena.loadHeader(Header.RootPayload);
    words[payload / WORD] = HAMT_COLLISION;
    words[payload / WORD + 1] = 2_000_000_000;
  }

  assert.throws(() => reader.acquire().toJSON(), /collision node|does not fit/);
  reader.detach();
});

test("a vector with an impossible element count is rejected", () => {
  const { owner, reader } = setup(VerifyMode.Off);
  owner.commit({ list: [1, 2, 3] });

  const words = owner.arena.words;
  const start = owner.arena.geometry.arenaOffset / WORD;
  for (let index = start; index < words.length; index += 1) {
    if (words[index] === VECTOR_MAGIC) {
      words[index + 1] = 2_000_000_000;
      break;
    }
  }

  assert.throws(() => reader.acquire().toJSON(), /impossible count/);
  reader.detach();
});

test("a bigint with a large length decodes in linear time rather than quadratic", () => {
  const { owner, reader } = setup(VerifyMode.Off);
  owner.commit({ big: 2n ** 4096n });

  const started = Date.now();
  const value = (reader.acquire().toJSON() as { big: bigint }).big;
  assert.equal(value, 2n ** 4096n);
  assert.ok(
    Date.now() - started < 1000,
    "a four thousand bit bigint should decode instantly, not in a quadratic loop",
  );
  reader.detach();
});
