/**
 * FNV-1a over 32 bit words.
 *
 * Chosen because it is a few instructions per word, needs no table, and is computed once
 * per commit rather than once per read. It detects accidental corruption and buggy writers.
 * It is not a message authentication code, and the trust model says so plainly: a window
 * that can write the arena can also write a matching checksum.
 */
const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

export function mixWord(hash: number, word: number): number {
  let next = Math.imul(hash ^ (word & 0xff), PRIME);
  next = Math.imul(next ^ ((word >>> 8) & 0xff), PRIME);
  next = Math.imul(next ^ ((word >>> 16) & 0xff), PRIME);
  next = Math.imul(next ^ ((word >>> 24) & 0xff), PRIME);
  return next | 0;
}

export function hashWords(words: Int32Array, start: number, count: number): number {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < count; i += 1) {
    hash = mixWord(hash, words[start + i] as number);
  }
  return hash | 0;
}

export function hashString(text: string): number {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    hash = Math.imul(hash ^ (unit & 0xff), PRIME);
    hash = Math.imul(hash ^ (unit >>> 8), PRIME);
  }
  return hash | 0;
}

export const HASH_SEED = OFFSET_BASIS;
