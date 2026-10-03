import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVarint, decodeVarint, pushVarint } from '../src/varint.js';
import { ChunkedBitset } from '../src/bitset.js';

test('varint roundtrip over boundary values', () => {
  const values = [0, 1, 127, 128, 255, 300, 16384, 2 ** 21, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1];
  for (const v of values) {
    const enc = encodeVarint(v);
    const { value, offset } = decodeVarint(enc, 0);
    assert.equal(value, v);
    assert.equal(offset, enc.length);
  }
});

test('varint rejects negative / unsafe integers', () => {
  assert.throws(() => pushVarint([], -1));
  assert.throws(() => pushVarint([], 2 ** 53));
});

test('chunked bitset set/has/size/positions', () => {
  const bs = new ChunkedBitset();
  for (const p of [0, 1, 31, 32, 33, 100, 1000, 4097]) bs.set(p);
  assert.equal(bs.size, 8);
  for (const p of [0, 1, 31, 32, 33, 100, 1000, 4097]) assert.ok(bs.has(p));
  for (const p of [2, 30, 34, 99, 101, 999, 4096, 4098]) assert.ok(!bs.has(p));
  assert.deepEqual(bs.positions(), [0, 1, 31, 32, 33, 100, 1000, 4097]);
});

test('chunked bitset encode/decode roundtrip, sparse and dense', () => {
  const cases = [
    [],
    [0],
    [5],
    [0, 1, 2, 3, 31, 32, 33, 63, 64, 65],
    [7, 700, 70000, 7000000],
    Array.from({ length: 200 }, (_, i) => i * 3),
  ];
  for (const positions of cases) {
    const bs = new ChunkedBitset();
    for (const p of positions) bs.set(p);
    const enc = bs.encode();
    const { bitset, offset } = ChunkedBitset.decode(enc, 0);
    assert.equal(offset, enc.length);
    assert.deepEqual(bitset.positions(), positions);
  }
});
