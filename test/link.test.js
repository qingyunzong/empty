'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Deframer, LinkSession } = require('../link');
const { encodeFrame, decodeFrame, FrameError, TYPE } = require('../frame');

const mk = (over = {}) => encodeFrame({ type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 10, seq: 1, ...over });

test('deframer handles arbitrary fragmentation (byte-by-byte == whole)', () => {
  const stream = Buffer.concat([mk(), mk({ seq: 2 }), mk({ seq: 3 })]);
  const whole = new Deframer();
  const wholeFrames = whole.push(stream);
  whole.finish();
  const drip = new Deframer();
  const dripFrames = [];
  for (let i = 0; i < stream.length; i++) dripFrames.push(...drip.push(stream.subarray(i, i + 1)));
  drip.finish();
  assert.deepEqual(dripFrames, wholeFrames);
  assert.equal(wholeFrames.length, 3);
});

test('deframer reassembles frames split across odd chunks', () => {
  const stream = Buffer.concat([mk(), mk({ seq: 2 })]);
  const d = new Deframer();
  const frames = [];
  for (let off = 0; off < stream.length; off += 13) frames.push(...d.push(stream.subarray(off, off + 13)));
  d.finish();
  assert.deepEqual(frames.map((f) => f.seq), [1, 2]);
});

test('corrupt checksum is rejected', () => {
  const bad = Buffer.from(mk());
  bad[20] ^= 0xff;
  const d = new Deframer();
  assert.throws(() => d.push(bad), FrameError);
});

test('corrupt len field is rejected', () => {
  const good = mk();
  const bad = Buffer.from(good);
  bad.writeUInt16BE(999, 0);
  // fix checksum so only the len field is wrong
  const { crc32 } = require('../frame');
  bad.writeUInt32BE(crc32(bad.subarray(0, 32)), 32);
  const d = new Deframer();
  assert.throws(() => d.push(bad), FrameError);
});

test('truncated tail is rejected at finish()', () => {
  const d = new Deframer();
  d.push(mk().subarray(0, 20));
  assert.throws(() => d.finish(), FrameError);
});

test('link session dedups retransmissions', () => {
  const ls = new LinkSession();
  const f = decodeFrame(mk());
  assert.equal(ls.ingest(f)[0].duplicate, false);
  assert.equal(ls.ingest(f)[0].duplicate, true);
  assert.equal(ls.ingest(f)[0].duplicate, true);
});

test('link session buffers out-of-order frames and drains in seq order', () => {
  const ls = new LinkSession();
  const f1 = decodeFrame(mk({ seq: 1 }));
  const f2 = decodeFrame(mk({ seq: 2 }));
  const f3 = decodeFrame(mk({ seq: 3 }));
  assert.deepEqual(ls.ingest(f3), []); // parked
  assert.deepEqual(ls.ingest(f1).map((d) => d.frame.seq), [1]); // gap at 2
  assert.deepEqual(ls.ingest(f2).map((d) => d.frame.seq), [2, 3]); // drains
});

test('seq tracking is per member', () => {
  const ls = new LinkSession();
  const a1 = decodeFrame(mk({ member: 'ALICE', seq: 1 }));
  const b1 = decodeFrame(mk({ member: 'BOB', seq: 1 }));
  assert.equal(ls.ingest(a1).length, 1);
  assert.equal(ls.ingest(b1).length, 1);
});
