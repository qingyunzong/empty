'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeVarints, decodeVarints, deltaEncode, deltaDecode } = require('../src/encoding');
const { encodePostings, decodePostings } = require('../src/postings');

test('varint roundtrip over assorted magnitudes', () => {
  const nums = [0, 1, 127, 128, 300, 65535, 2 ** 31, 2 ** 52];
  const buf = encodeVarints(nums);
  const { values, offset } = decodeVarints(buf);
  assert.deepEqual(values, nums);
  assert.equal(offset, buf.length);
});

test('delta encode/decode roundtrip', () => {
  const sorted = [3, 5, 5, 9, 100, 101];
  assert.deepEqual(deltaDecode(deltaEncode(sorted)), sorted);
});

test('postings roundtrip with skip list', () => {
  const positions = [];
  let p = 0;
  for (let i = 0; i < 100; i++) {
    p += 1 + (i % 5);
    positions.push(p);
  }
  const entry = encodePostings(positions);
  assert.equal(entry.count, positions.length);
  assert.ok(entry.skips.length > 0, 'skip list must be populated');
  assert.deepEqual(decodePostings(entry), positions);
});

test('postings decode with lower bound uses skips and stays exact', () => {
  const positions = [];
  let p = 0;
  for (let i = 0; i < 64; i++) {
    p += 2;
    positions.push(p);
  }
  const entry = encodePostings(positions);
  for (const minPos of [0, 1, 17, 50, 128, 129]) {
    assert.deepEqual(
      decodePostings(entry, minPos),
      positions.filter((x) => x >= minPos),
      `minPos=${minPos}`,
    );
  }
});
