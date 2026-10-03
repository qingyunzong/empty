'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Framer } = require('../lib/framer');
const { ParseError } = require('../lib/frame');
const { frame } = require('./helpers');

test('sticky frames: concatenated stream parses all frames in order', () => {
  const stream = Buffer.concat([
    frame(0, 'WELD_START', { orderId: 'A', weldId: 'w0' }),
    frame(1, 'WELD_END', { orderId: 'A', weldId: 'w0' }),
    frame(2, 'UNDO', { orderId: 'A', targetSeq: 1 }),
  ]);
  const framer = new Framer();
  const frames = [...framer.push(stream), ...framer.end()];
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2]);
  assert.deepEqual(frames.map((f) => f.typeName), ['WELD_START', 'WELD_END', 'UNDO']);
});

test('half frames: byte-by-byte feed recovers identical frames', () => {
  const stream = Buffer.concat([
    frame(0, 'WELD_START', { orderId: 'B' }),
    frame(1, 'WELD_END', { orderId: 'B' }),
  ]);
  const framer = new Framer();
  const frames = [];
  for (let i = 0; i < stream.length; i++) frames.push(...framer.push(stream.subarray(i, i + 1)));
  frames.push(...framer.end());
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.seq), [0, 1]);
});

test('bad magic reports BAD_MAGIC with absolute offset', () => {
  const good = frame(0, 'WELD_START', { orderId: 'A' });
  const bad = Buffer.from(good);
  bad[0] = 0x00;
  const framer = new Framer();
  framer.push(good); // consume good frame, base advances
  const framer2 = new Framer();
  assert.throws(() => framer2.push(Buffer.concat([good, bad])), (err) => {
    assert.ok(err instanceof ParseError);
    assert.equal(err.code, 'BAD_MAGIC');
    assert.equal(err.offset, good.length);
    return true;
  });
});

test('crc mismatch reports CRC_MISMATCH at crc field offset', () => {
  const buf = Buffer.from(frame(0, 'WELD_START', { orderId: 'A' }));
  buf[buf.length - 1] ^= 0xff;
  const framer = new Framer();
  assert.throws(() => framer.push(buf), (err) => {
    assert.equal(err.code, 'CRC_MISMATCH');
    assert.equal(err.offset, buf.length - 2);
    return true;
  });
});

test('truncated tail at end() reports TRUNCATED_FRAME at frame start', () => {
  const buf = frame(0, 'WELD_START', { orderId: 'A' });
  const framer = new Framer();
  framer.push(buf.subarray(0, buf.length - 3));
  assert.throws(() => framer.end(), (err) => {
    assert.equal(err.code, 'TRUNCATED_FRAME');
    assert.equal(err.offset, 0);
    return true;
  });
});

test('unknown type reports UNKNOWN_TYPE at type byte offset', () => {
  const { encodeFrame } = require('../lib/frame');
  const buf = encodeFrame({ type: 0x7f, seq: 0, ack: 0, payload: {} });
  const framer = new Framer();
  assert.throws(() => framer.push(buf), (err) => {
    assert.equal(err.code, 'UNKNOWN_TYPE');
    assert.equal(err.offset, 4);
    return true;
  });
});
