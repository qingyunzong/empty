import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { decodeVlqAll, encodeVlq } from '../src/vlq.js';

test('decodes known single-value vectors', () => {
  deepEqual(decodeVlqAll('A'), [0]);
  deepEqual(decodeVlqAll('C'), [1]);
  deepEqual(decodeVlqAll('D'), [-1]);
  deepEqual(decodeVlqAll('U'), [10]);
  deepEqual(decodeVlqAll('8B'), [30]);
  deepEqual(decodeVlqAll('AAAA'), [0, 0, 0, 0]);
});

test('encode/decode round-trips across a wide range', () => {
  for (let v = -100000; v <= 100000; v += 97) {
    equal(decodeVlqAll(encodeVlq(v))[0], v, `round-trip ${v}`);
  }
  for (const v of [0, 1, -1, 15, -16, 2 ** 20, -(2 ** 20), 2 ** 30, -(2 ** 30)]) {
    equal(decodeVlqAll(encodeVlq(v))[0], v, `round-trip ${v}`);
  }
});

test('encodes known values', () => {
  equal(encodeVlq(0), 'A');
  equal(encodeVlq(1), 'C');
  equal(encodeVlq(-1), 'D');
  equal(encodeVlq(10), 'U');
  equal(encodeVlq(30), '8B');
});
