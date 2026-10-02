'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { encodeFrame, FrameDecoder } = require('../src/frame');
const { canonical } = require('../src/canon');
const { PacklineError, EXIT } = require('../src/errors');
const { ev, scenarioEvents } = require('./helpers');

function decodeAll(bytes, chunkSize) {
  const decoder = new FrameDecoder();
  const events = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    events.push(...decoder.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length))));
  }
  decoder.end();
  return events;
}

test('frame roundtrip preserves the event', () => {
  const src = ev({ batch: 'B1', item: 'X', seq: 7, lamport: 3, kind: 'PACK', qty: 2 });
  const [decoded] = decodeAll(encodeFrame(src), 1 << 16);
  assert.deepEqual(decoded, src);
});

test('decoder is fragmentation-safe down to 1-byte chunks', () => {
  const src = scenarioEvents();
  const stream = Buffer.concat(src.map((e) => encodeFrame(e)));
  for (const chunkSize of [1, 3, 7, 64, stream.length]) {
    const decoded = decodeAll(stream, chunkSize);
    assert.deepEqual(decoded, src);
  }
});

test('bad magic is a frame error (exit 2)', () => {
  const frame = Buffer.from(encodeFrame(ev({ batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 })));
  frame[0] = 0x00;
  assert.throws(
    () => new FrameDecoder().push(frame),
    (err) => err instanceof PacklineError && err.exitCode === EXIT.FRAME
  );
});

test('crc mismatch is a frame error (exit 2)', () => {
  const frame = Buffer.from(encodeFrame(ev({ batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 })));
  frame[frame.length - 1] ^= 0xff;
  assert.throws(() => new FrameDecoder().push(frame), (err) => err.exitCode === EXIT.FRAME);
});

test('truncated tail is rejected by end()', () => {
  const frame = encodeFrame(ev({ batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 }));
  const decoder = new FrameDecoder();
  decoder.push(frame.subarray(0, frame.length - 5));
  assert.throws(() => decoder.end(), (err) => err.exitCode === EXIT.FRAME);
});

test('tampered payload fails signature verification', () => {
  const src = ev({ batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 });
  // Keep the original id/sig but alter the signed content, then wrap the
  // forged payload in a structurally valid frame (correct magic and crc).
  const forged = { ...src, qty: 999 };
  const payload = Buffer.from(canonical(forged), 'utf8');
  const frame = Buffer.alloc(4 + payload.length + 4);
  frame[0] = 0x50;
  frame[1] = 0x4b;
  frame.writeUInt16BE(payload.length, 2);
  payload.copy(frame, 4);
  frame.writeUInt32BE(zlib.crc32(payload) >>> 0, 4 + payload.length);
  assert.throws(() => decodeAll(frame, 1 << 16), (err) => err.exitCode === EXIT.FRAME);
});

test('schema violations are frame errors', () => {
  const base = { batch: 'B', item: 'X', seq: 0, lamport: 0, kind: 'PACK', qty: 1 };
  const cases = [
    { ...base, kind: 'NOPE' },
    { ...base, seq: -1 },
    { ...base, lamport: 1.5 },
    { ...base, ref: 'ab'.repeat(32) },
    { ...base, kind: 'CORRECT', ref: null, reason: 'x' },
    { ...base, kind: 'CORRECT', ref: 'ab'.repeat(32), reason: null },
  ];
  for (const fields of cases) {
    assert.throws(() => decodeAll(encodeFrame(fields), 1 << 16), (err) => err.exitCode === EXIT.FRAME);
  }
});
