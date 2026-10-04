'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, decodeFrame, FrameStream, FrameError } = require('../lib/frame');
const { GENESIS } = require('../lib/log');

const sample = {
  opId: 'ab'.repeat(16),
  actor: 'alice',
  cmd: 'set',
  args: { key: 'x', value: [1, 2, { y: 'z' }] },
  prevHash: GENESIS,
  seq: 7,
  ack: 6,
  leaseUntil: 1000,
};

test('frame encode/decode roundtrip', () => {
  const decoded = decodeFrame(encodeFrame(sample));
  assert.deepEqual(decoded, sample);
});

test('fragmentation: byte-by-byte reassembly of concatenated frames', () => {
  const f1 = encodeFrame(sample);
  const f2 = encodeFrame({ ...sample, opId: 'cd'.repeat(16), seq: 8 });
  const f3 = encodeFrame({ ...sample, opId: 'ef'.repeat(16), seq: 9 });
  const blob = Buffer.concat([f1, f2, f3]);
  const stream = new FrameStream();
  const got = [];
  for (let i = 0; i < blob.length; i++) got.push(...stream.push(blob.subarray(i, i + 1)));
  stream.end();
  assert.equal(got.length, 3);
  assert.equal(got[0].frame.seq, 7);
  assert.equal(got[1].frame.seq, 8);
  assert.equal(got[2].frame.seq, 9);
  assert.ok(got[0].raw.equals(f1));
});

test('odd chunk sizes reassemble correctly', () => {
  const blob = Buffer.concat([encodeFrame(sample), encodeFrame({ ...sample, seq: 2 })]);
  for (const size of [3, 7, 64, 4096]) {
    const stream = new FrameStream();
    const got = [];
    for (let off = 0; off < blob.length; off += size) got.push(...stream.push(blob.subarray(off, off + size)));
    stream.end();
    assert.equal(got.length, 2, 'chunk size ' + size);
  }
});

test('crc corruption is detected', () => {
  const buf = encodeFrame(sample);
  buf[buf.length - 2] ^= 0xff;
  const stream = new FrameStream();
  assert.throws(() => stream.push(buf), (e) => e instanceof FrameError && e.reason === 'bad_crc');
});

test('bad magic is detected', () => {
  const buf = encodeFrame(sample);
  buf[0] = 0x00;
  const stream = new FrameStream();
  assert.throws(() => stream.push(buf), (e) => e instanceof FrameError && e.reason === 'bad_magic');
});

test('truncated trailing frame is detected at end()', () => {
  const buf = encodeFrame(sample).subarray(0, 20);
  const stream = new FrameStream();
  stream.push(buf);
  assert.throws(() => stream.end(), (e) => e instanceof FrameError && e.reason === 'truncated_frame');
});
