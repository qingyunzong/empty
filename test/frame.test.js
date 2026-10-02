'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, encodeStream, FrameParser, MacError } = require('../src/frame');

const KEY = 'test-key';

test('roundtrip single frame fed byte by byte', () => {
  const msg = { authId: 'H1', type: 'hold', seq: 1, amount: 500, ts: 0, ack: 0 };
  const bin = encodeFrame(msg, { key: KEY });
  const parser = new FrameParser(KEY);
  const out = [];
  for (const byte of bin) out.push(...parser.push(Buffer.from([byte])));
  parser.end();
  assert.deepEqual(out, [msg]);
});

test('fragmented frame reassembles across chunk boundaries', () => {
  const msg = { authId: 'LONG-AUTH-ID-0001', type: 'complete', seq: 9, amount: 123456, ts: 42, ack: 8 };
  const bin = encodeFrame(msg, { key: KEY, fragmentSize: 5 });
  const parser = new FrameParser(KEY);
  const out = [];
  for (let off = 0; off < bin.length; off += 3) out.push(...parser.push(bin.subarray(off, off + 3)));
  parser.end();
  assert.deepEqual(out, [msg]);
});

test('multiple frames in one stream', () => {
  const msgs = [
    { authId: 'A', type: 'hold', seq: 1, amount: 100, ts: 0 },
    { authId: 'A', type: 'inc', seq: 2, amount: 50, ts: 1 },
    { authId: 'B', type: 'hold', seq: 1, amount: 200, ts: 2 },
  ];
  const bin = encodeStream(msgs, { key: KEY, fragmentSize: 11 });
  const parser = new FrameParser(KEY);
  const out = parser.push(bin);
  parser.end();
  assert.deepEqual(out, msgs);
});

test('tampered mac raises MacError with exitCode 2', () => {
  const bin = Buffer.from(encodeFrame({ authId: 'A', type: 'hold', seq: 1, amount: 1, ts: 0 }, { key: KEY }));
  bin[bin.length - 1] ^= 0xff;
  const parser = new FrameParser(KEY);
  assert.throws(() => parser.push(bin), (err) => err instanceof MacError && err.exitCode === 2);
});

test('wrong key raises MacError', () => {
  const bin = encodeFrame({ authId: 'A', type: 'hold', seq: 1, amount: 1, ts: 0 }, { key: KEY });
  const parser = new FrameParser('other-key');
  assert.throws(() => parser.push(bin), MacError);
});

test('truncated stream detected at end', () => {
  const bin = encodeFrame({ authId: 'A', type: 'hold', seq: 1, amount: 1, ts: 0 }, { key: KEY });
  const parser = new FrameParser(KEY);
  parser.push(bin.subarray(0, bin.length - 2));
  assert.throws(() => parser.end(), MacError);
});
