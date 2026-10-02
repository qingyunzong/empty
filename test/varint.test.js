import test from 'node:test';
import assert from 'node:assert/strict';
import { writeVarint, readVarint, encodeSegment, decodeSegment } from '../src/varint.js';

function roundtrip(n) {
  const out = [];
  writeVarint(out, n);
  const state = { offset: 0 };
  const v = readVarint(Buffer.from(out), state);
  assert.equal(v, n);
  assert.equal(state.offset, out.length);
}

test('varint roundtrips boundaries and large values', () => {
  for (const n of [0, 1, 127, 128, 129, 255, 300, 16383, 16384, 2 ** 21, 2 ** 31 - 1, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    roundtrip(n);
  }
});

test('varint rejects negative and unsafe integers', () => {
  assert.throws(() => writeVarint([], -1));
  assert.throws(() => writeVarint([], 1.5));
});

test('segment codec roundtrips docs, positions and tombstones', () => {
  const seg = {
    docs: {
      'WO-21': { 轴: [0, 5, 9], 承: [1], pump2: [3, 4] },
      'WO-1012': { 热: [2, 7, 8, 30] },
    },
    tombstones: ['WO-11', 'WO-12'],
  };
  const decoded = decodeSegment(encodeSegment(seg));
  assert.deepEqual(decoded, seg);
});

test('segment decoder rejects truncated data', () => {
  const buf = encodeSegment({ docs: { 'A1': { x: [1, 2, 3] } }, tombstones: [] });
  assert.throws(() => decodeSegment(buf.subarray(0, buf.length - 2)));
});

test('segment decoder rejects trailing bytes', () => {
  const buf = Buffer.concat([encodeSegment({ docs: {}, tombstones: [] }), Buffer.from([1])]);
  assert.throws(() => decodeSegment(buf));
});
