'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Framer } = require('../src/framer');
const { encodeFrame } = require('../src/frame');
const { start, end, stream } = require('../testlib/helpers');

test('sticky frames: concatenated frames parse in order', () => {
  const f = new Framer();
  const buf = stream(start('WO-1', 0), end('WO-1', 1), start('WO-2', 2));
  const { frames, error } = f.push(buf);
  assert.equal(error, null);
  assert.deepEqual(frames.map((x) => [x.seq, x.typeName, x.wo]), [
    [0, 'WELD_START', 'WO-1'],
    [1, 'WELD_END', 'WO-1'],
    [2, 'WELD_START', 'WO-2'],
  ]);
  assert.equal(f.finish(), null);
});

test('half frame: byte-by-byte feeding recovers identical frames', () => {
  const buf = stream(start('WO-7', 0), end('WO-7', 1));
  const f = new Framer();
  const frames = [];
  for (let i = 0; i < buf.length; i++) {
    const r = f.push(buf.subarray(i, i + 1));
    assert.equal(r.error, null);
    frames.push(...r.frames);
  }
  assert.equal(f.finish(), null);
  assert.deepEqual(frames.map((x) => [x.seq, x.typeName, x.wo]), [
    [0, 'WELD_START', 'WO-7'],
    [1, 'WELD_END', 'WO-7'],
  ]);
});

test('split at every position yields the same frames as whole-buffer', () => {
  const buf = stream(start('A', 0), end('A', 1), start('B', 2), end('B', 3));
  const whole = new Framer().push(buf).frames;
  for (let cut = 0; cut <= buf.length; cut++) {
    const f = new Framer();
    const r1 = f.push(buf.subarray(0, cut));
    const r2 = f.push(buf.subarray(cut));
    assert.equal(r1.error, null);
    assert.equal(r2.error, null);
    assert.deepEqual([...r1.frames, ...r2.frames], whole, `cut at ${cut}`);
    assert.equal(f.finish(), null);
  }
});

test('truncated trailing half frame reports TRUNCATED at frame offset', () => {
  const good = start('WO-1', 0);
  const half = end('WO-1', 1).subarray(0, 5);
  const f = new Framer();
  const r = f.push(stream(good, half));
  assert.equal(r.error, null);
  assert.equal(r.frames.length, 1);
  assert.deepEqual(f.finish(), { code: 'TRUNCATED', offset: good.length });
});

test('bad magic reports offset of offending byte', () => {
  const f = new Framer();
  const r = f.push(Buffer.from([0xab, 0x00]));
  assert.deepEqual(r.error, { code: 'BAD_MAGIC', offset: 1 });
});

test('bad crc reports frame offset', () => {
  const good = start('WO-1', 0);
  const bad = Buffer.from(end('WO-1', 1));
  bad[10] ^= 0xFF; // corrupt payload
  const f = new Framer();
  const r = f.push(stream(good, bad));
  assert.equal(r.frames.length, 1);
  assert.deepEqual(r.error, { code: 'BAD_CRC', offset: good.length });
});

test('bad len and unknown type are parse errors with offsets', () => {
  const f1 = new Framer();
  const r1 = f1.push(Buffer.from([0xab, 0xcd, 0xff]));
  assert.deepEqual(r1.error, { code: 'BAD_LEN', offset: 2 });

  const frame = Buffer.from(encodeFrame({ seq: 0, type: 'UNDO', payload: 'W' }));
  frame[7] = 0x7f; // unknown type; fix crc so only the type check fails
  const { crc16ccitt } = require('../src/crc16');
  const crc = crc16ccitt(Buffer.concat([frame.subarray(2, 3), frame.subarray(5)]));
  frame[3] = crc >> 8; frame[4] = crc & 0xff;
  const f2 = new Framer();
  const r2 = f2.push(frame);
  assert.deepEqual(r2.error, { code: 'UNKNOWN_TYPE', offset: 7 });
});
