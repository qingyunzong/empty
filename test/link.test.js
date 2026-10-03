'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Link } = require('../lib/link');
const { TYPE, encodeFrame, fragmentFrame, CorruptFrameError } = require('../lib/frame');

const F = (seq, tick = seq) => encodeFrame({ type: TYPE.RESERVE, member: 'alice', reqId: seq, amount: 10, seq, tick });

test('in-order frames are delivered immediately', () => {
  const link = new Link();
  const out = [...link.push(Buffer.concat([F(1), F(2)])), ...link.end()];
  assert.deepEqual(out.map((f) => f.seq), [1, 2]);
});

test('out-of-order frames are reordered by seq', () => {
  const link = new Link();
  assert.deepEqual(link.push(F(3)), []);
  assert.deepEqual(link.push(F(1)).map((f) => f.seq), [1]);
  assert.deepEqual(link.push(F(2)).map((f) => f.seq), [2, 3]);
  assert.deepEqual(link.end(), []);
});

test('retransmitted frames are de-duplicated', () => {
  const link = new Link();
  const out = [...link.push(Buffer.concat([F(1), F(1), F(2), F(2)])), ...link.end()];
  assert.equal(link.duplicates, 2);
  assert.deepEqual(out.map((f) => f.seq), [1, 2]);
});

test('conflicting retransmission of a seq is corruption', () => {
  const link = new Link();
  link.push(F(1));
  const conflict = encodeFrame({ type: TYPE.RESERVE, member: 'alice', reqId: 999, amount: 10, seq: 1, tick: 1 });
  assert.throws(() => link.push(conflict), CorruptFrameError);
});

test('fragmented frames are reassembled, interleaved with other traffic', () => {
  const a = F(1);
  const b = encodeFrame({ type: TYPE.COMMIT, member: 'bob', reqId: 2, amount: 5, seq: 2, tick: 2 });
  const fa = fragmentFrame(a, 'alice', 1, 15);
  const fb = fragmentFrame(b, 'bob', 2, 13);
  const link = new Link();
  const out = [];
  // interleave fragments of both frames, shuffled
  for (const rec of [fa[0], fb[0], fa[2], fb[1], fa[1], fb[2], fa[0]]) {
    out.push(...link.push(rec));
  }
  out.push(...link.end());
  assert.deepEqual(out.map((f) => f.seq), [1, 2]);
  assert.deepEqual(out[1], { type: TYPE.COMMIT, flags: 0, member: 'bob', reqId: 2, amount: 5, seq: 2, ack: 0, tick: 2 });
  assert.equal(link.duplicates, 1); // repeated fa[0]
});

test('byte-level splits across push() calls are handled', () => {
  const link = new Link();
  const bytes = Buffer.concat([F(1), F(2)]);
  const out = [];
  for (const byte of bytes) out.push(...link.push(Buffer.from([byte])));
  out.push(...link.end());
  assert.deepEqual(out.map((f) => f.seq), [1, 2]);
});

test('truncated trailing bytes at end() are corruption', () => {
  const link = new Link();
  link.push(Buffer.concat([F(1), Buffer.from([0xc1, 0xea, 0x00])]));
  assert.throws(() => link.end(), CorruptFrameError);
});

test('incomplete fragments at end() are corruption', () => {
  const link = new Link();
  link.push(fragmentFrame(F(1), 'alice', 1, 15)[0]);
  assert.throws(() => link.end(), CorruptFrameError);
});

test('bad magic in the stream is corruption', () => {
  const link = new Link();
  const bad = Buffer.from(F(1));
  bad[0] = 0;
  assert.throws(() => link.push(bad), CorruptFrameError);
});
