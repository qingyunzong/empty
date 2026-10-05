import { test } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { decodeVlq, encodeVlq } from '../src/index.js';

test('vlq encodes known values', () => {
  strictEqual(encodeVlq(0), 'A');
  strictEqual(encodeVlq(1), 'C');
  strictEqual(encodeVlq(-1), 'D');
  strictEqual(encodeVlq(15), 'e');
  strictEqual(encodeVlq(-16), 'hB');
  strictEqual(encodeVlq(31), '+B');
  strictEqual(encodeVlq(32), 'gC');
});

test('vlq round-trips over a wide range', () => {
  const values = [0, 1, -1, 2, -2, 15, -16, 31, -31, 32, -32, 1023, -1024, 65535, -65536];
  for (const value of values) {
    const decoded = decodeVlq(encodeVlq(value), 0);
    deepStrictEqual(decoded, { value, next: encodeVlq(value).length });
  }
});

test('vlq rejects invalid digits and truncated input', () => {
  throws(() => decodeVlq('!', 0));
  throws(() => decodeVlq('', 0));
});
