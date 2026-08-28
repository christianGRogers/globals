import { parentPort, workerData } from "node:worker_threads";

const { role, sab, seconds, increments, payloadWords } = workerData;
const i32 = new Int32Array(sab);

// Layout, in Int32 words.
// 0: contended counter
// 1: message passing sequence number
// 2: seqlock sequence number
// 3: seqlock field a
// 4: seqlock field b
// 8 .. 8+payloadWords: message passing payload
const COUNTER = 0;
const MP_SEQ = 1;
const SEQ = 2;
const FIELD_A = 3;
const FIELD_B = 4;
const PAYLOAD = 8;

function contendedIncrement() {
  for (let n = 0; n < increments; n += 1) {
    for (;;) {
      const current = Atomics.load(i32, COUNTER);
      if (Atomics.compareExchange(i32, COUNTER, current, current + 1) === current) break;
    }
  }
  return { role, increments };
}

function messagePassingWriter() {
  const deadline = Date.now() + seconds * 1000;
  let generation = 0;
  while (Date.now() < deadline) {
    generation += 1;
    // Fill the payload first, then release the sequence number. A reader that sees the
    // new sequence must therefore see the whole payload.
    for (let w = 0; w < payloadWords; w += 1) {
      i32[PAYLOAD + w] = generation;
    }
    Atomics.store(i32, MP_SEQ, generation);
  }
  Atomics.store(i32, MP_SEQ, -1);
  return { role, generations: generation };
}

function messagePassingReader() {
  let reads = 0;
  let violations = 0;
  for (;;) {
    const seq = Atomics.load(i32, MP_SEQ);
    if (seq === -1) break;
    if (seq === 0) continue;
    let torn = false;
    for (let w = 0; w < payloadWords; w += 1) {
      if (i32[PAYLOAD + w] < seq) {
        torn = true;
        break;
      }
    }
    reads += 1;
    if (torn) violations += 1;
  }
  return { role, reads, violations };
}

function seqlockWriter() {
  const deadline = Date.now() + seconds * 1000;
  let version = 0;
  while (Date.now() < deadline) {
    version += 1;
    Atomics.store(i32, SEQ, version * 2 - 1); // odd, write in progress
    i32[FIELD_A] = version;
    i32[FIELD_B] = -version;
    Atomics.store(i32, SEQ, version * 2); // even, write complete
  }
  Atomics.store(i32, SEQ, -1);
  return { role, versions: version };
}

function seqlockReader() {
  let reads = 0;
  let retries = 0;
  let violations = 0;
  for (;;) {
    const before = Atomics.load(i32, SEQ);
    if (before === -1) break;
    if (before % 2 !== 0) {
      retries += 1;
      continue;
    }
    const a = i32[FIELD_A];
    const b = i32[FIELD_B];
    const after = Atomics.load(i32, SEQ);
    if (after !== before) {
      retries += 1;
      continue;
    }
    reads += 1;
    if (a !== -b) violations += 1;
  }
  return { role, reads, retries, violations };
}

const handlers = {
  "contended-increment": contendedIncrement,
  "mp-writer": messagePassingWriter,
  "mp-reader": messagePassingReader,
  "seqlock-writer": seqlockWriter,
  "seqlock-reader": seqlockReader,
};

const handler = handlers[role];
if (!handler) throw new Error(`unknown worker role: ${role}`);
parentPort.postMessage(handler());
