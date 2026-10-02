'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeDeltas, decodeDeltas, encodeVarint } = require('../src/varint');

test('varint delta roundtrip', () => {
  const cases = [
    [],
    [0],
    [0, 0, 0],
    [1, 2, 300, 65536, 2 ** 40],
    Array.from({ length: 1000 }, (_, i) => i * 7),
  ];
  for (const c of cases) {
    assert.deepEqual(decodeDeltas(encodeDeltas(c)), c);
  }
});

test('varint rejects negative', () => {
  assert.throws(() => encodeVarint(-1), RangeError);
  assert.throws(() => encodeDeltas([3, 1]), RangeError); // not ascending
});
