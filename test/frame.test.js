'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, FrameDecoder, ProtocolError, TYPE, VERSION } = require('../src/frame');
const { crc32 } = require('../src/crc32');

const sample = () => encode({
  type: TYPE.DATA, batchId: 7, lineNo: 3, seq: 42, ack: 0,
  payload: Buffer.from(JSON.stringify({ hello: 'world' })),
});

test('encode/decode roundtrip preserves all fields', () => {
  const dec = new FrameDecoder();
  const frames = dec.push(sample());
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.version, VERSION);
  assert.equal(f.type, TYPE.DATA);
  assert.equal(f.batchId, 7);
  assert.equal(f.lineNo, 3);
  assert.equal(f.seq, 42);
  assert.deepEqual(JSON.parse(f.payload.toString('utf8')), { hello: 'world' });
});

test('crc32 known vector ("123456789" -> 0xCBF43926)', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('frame split into two segments (and byte-by-byte) is reassembled', () => {
  const wire = Buffer.concat([sample(), sample()]);
  const dec = new FrameDecoder();
  const out = [];
  for (let i = 0; i < wire.length; i++) out.push(...dec.push(wire.subarray(i, i + 1)));
  assert.equal(out.length, 2);
  assert.equal(out[0].seq, 42);
  assert.equal(out[1].seq, 42);
});

test('garbage between frames is skipped via magic resync', () => {
  const dec = new FrameDecoder();
  const wire = Buffer.concat([Buffer.from([0x00, 0x11, 0xC7, 0x99, 0x22]), sample()]);
  const frames = dec.push(wire);
  assert.equal(frames.length, 1);
  assert.ok(dec.stats.resyncs >= 1);
});

test('CRC-corrupted frame is dropped, following frame still decodes', () => {
  const bad = Buffer.from(sample());
  bad[bad.length - 6] ^= 0xFF; // flip a payload byte
  const dec = new FrameDecoder();
  const frames = dec.push(Buffer.concat([bad, sample()]));
  assert.equal(frames.length, 1);
  assert.equal(dec.stats.crcErrors, 1);
});

test('valid CRC with unsupported version is a hard protocol error', () => {
  const body = Buffer.from(sample());
  body[2] = 99; // version
  body.writeUInt32BE(crc32(body.subarray(0, body.length - 4)), body.length - 4);
  const dec = new FrameDecoder();
  assert.throws(() => dec.push(body), (e) => e instanceof ProtocolError && e.code === 'BAD_VERSION');
});

test('decoder waits for a half frame across push boundaries', () => {
  const wire = sample();
  const half = wire.length >> 1;
  const dec = new FrameDecoder();
  assert.equal(dec.push(wire.subarray(0, half)).length, 0);
  assert.equal(dec.push(wire.subarray(half)).length, 1);
});
