'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32 } = require('../src/crc');
const { encodeFrame, decodeFrame, chunkFrame, Reassembler } = require('../src/frame');

const sample = { tx: 't1', phase: 'prepare', acct: 'A', amount: -10, seq: 3, ack: '', reason: '' };

test('crc32 known vector', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
});

test('frame roundtrip preserves all message fields', () => {
  const frame = encodeFrame(sample);
  const decoded = decodeFrame(frame);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.msg, sample);
});

test('corrupted frame is rejected', () => {
  const frame = encodeFrame(sample);
  const pos = frame.indexOf('t1');
  const bad = frame.slice(0, pos) + 'X' + frame.slice(pos + 1);
  assert.equal(decodeFrame(bad).ok, false);
});

test('invalid message cannot be encoded', () => {
  assert.throws(() => encodeFrame({ ...sample, phase: 'bogus' }));
  assert.throws(() => encodeFrame({ ...sample, seq: -1 }));
  assert.throws(() => encodeFrame({ ...sample, amount: 'x' }));
});

test('fragmentation: reassembly tolerates reorder and duplicate chunks', () => {
  const big = { ...sample, tx: 'tx-with-a-fairly-long-identifier-to-force-chunking', amount: -123456 };
  const frame = encodeFrame(big);
  const chunks = chunkFrame('f1', frame, 8);
  assert.ok(chunks.length > 3);
  const r = new Reassembler();
  let out = null;
  for (const c of [...chunks].reverse()) {
    out = r.push(c) ?? out;
    out = r.push(c) ?? out; // duplicate chunk must be idempotent
  }
  assert.equal(out, frame);
  const decoded = decodeFrame(out);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.msg, big);
});

test('fragmentation: missing chunk means no frame', () => {
  const frame = encodeFrame(sample);
  const chunks = chunkFrame('f2', frame, 5);
  const r = new Reassembler();
  let out = null;
  for (const c of chunks.slice(1)) out = r.push(c) ?? out;
  assert.equal(out, null);
});
