import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uvarintEncode, uvarintDecode, zigzagEncode, zigzagDecode } from '../src/varint.js';
import { crc32 } from '../src/crc32.js';

test('uvarint roundtrip', () => {
  for (const v of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 52]) {
    const enc = uvarintEncode(v);
    const dec = uvarintDecode(enc);
    assert.equal(dec.value, v);
    assert.equal(dec.offset, enc.length);
  }
});

test('uvarint detects truncation', () => {
  const enc = uvarintEncode(300); // multi-byte
  assert.throws(() => uvarintDecode(enc.subarray(0, 1)), RangeError);
});

test('zigzag roundtrip incl. negatives', () => {
  for (const v of [0, 1, -1, 5, -5, 123456, -987654, 2 ** 40, -(2 ** 40)]) {
    assert.equal(zigzagDecode(zigzagEncode(v)), v);
  }
});

test('crc32 known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
