'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TYPE, FRAME_LEN, CorruptFrameError,
  encodeFrame, decodeFrame, encodeFrag, decodeFrag, fragmentFrame, crc32,
} = require('../lib/frame');

test('frame round-trips for every request type', () => {
  for (const type of [TYPE.RESERVE, TYPE.COMMIT, TYPE.RELEASE, TYPE.EXPIRE]) {
    const input = { type, member: 'alice', reqId: 42, amount: 1000, seq: 7, ack: 6, tick: 99 };
    const decoded = decodeFrame(encodeFrame(input));
    assert.deepEqual(decoded, { ...input, flags: 0 });
  }
});

test('frame has the documented wire length', () => {
  const buf = encodeFrame({ type: TYPE.RESERVE, member: 'a', reqId: 1, amount: 1, seq: 1, tick: 0 });
  assert.equal(buf.length, FRAME_LEN);
  assert.equal(buf.readUInt16BE(2), FRAME_LEN);
});

test('member field is NUL-padded and decoded back exactly', () => {
  const short = decodeFrame(encodeFrame({ type: TYPE.RESERVE, member: 'bo', reqId: 1, amount: 1, seq: 1, tick: 0 }));
  assert.equal(short.member, 'bo');
  const full = decodeFrame(encodeFrame({ type: TYPE.RESERVE, member: 'abcdefgh', reqId: 1, amount: 1, seq: 1, tick: 0 }));
  assert.equal(full.member, 'abcdefgh');
});

test('crc32 matches the IEEE check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('tampered crc is rejected as corrupt', () => {
  const buf = Buffer.from(encodeFrame({ type: TYPE.RESERVE, member: 'alice', reqId: 1, amount: 1, seq: 1, tick: 0 }));
  buf[20] ^= 0xff;
  assert.throws(() => decodeFrame(buf), CorruptFrameError);
});

test('bad magic is rejected as corrupt', () => {
  const buf = Buffer.from(encodeFrame({ type: TYPE.RESERVE, member: 'alice', reqId: 1, amount: 1, seq: 1, tick: 0 }));
  buf.writeUInt16BE(0x0000, 0);
  assert.throws(() => decodeFrame(buf), CorruptFrameError);
});

test('invalid encode inputs are rejected', () => {
  assert.throws(() => encodeFrame({ type: TYPE.RESERVE, member: 'waytoolong', reqId: 1, amount: 1, seq: 1, tick: 0 }), RangeError);
  assert.throws(() => encodeFrame({ type: TYPE.RESERVE, member: 'a', reqId: -1, amount: 1, seq: 1, tick: 0 }), RangeError);
  assert.throws(() => encodeFrame({ type: TYPE.RESERVE, member: 'a', reqId: 1, amount: 2 ** 32, seq: 1, tick: 0 }), RangeError);
});

test('frag records round-trip and fragmentFrame covers the whole frame', () => {
  const frame = encodeFrame({ type: TYPE.COMMIT, member: 'bob', reqId: 9, amount: 5, seq: 3, tick: 2 });
  const frags = fragmentFrame(frame, 'bob', 3, 10);
  assert.equal(frags.length, 4);
  const decoded = frags.map(decodeFrag);
  assert.deepEqual(decoded.map((d) => d.offset), [0, 10, 20, 30]);
  assert.ok(decoded.every((d) => d.total === FRAME_LEN && d.seq === 3));
  const joined = Buffer.concat(decoded.sort((a, b) => a.offset - b.offset).map((d) => d.data));
  assert.ok(joined.equals(frame));
});

test('tampered frag crc is rejected as corrupt', () => {
  const frag = Buffer.from(encodeFrag({ member: 'bob', seq: 1, offset: 0, total: FRAME_LEN, data: Buffer.alloc(5) }));
  frag[10] ^= 1;
  assert.throws(() => decodeFrag(frag), CorruptFrameError);
});
