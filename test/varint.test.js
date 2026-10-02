import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVarints, decodeVarints, encodePositions, decodePositions } from '../src/varint.js';

test('varint round-trip', () => {
  const nums = [0, 1, 127, 128, 255, 300, 16384, 2 ** 31, 2 ** 40];
  assert.deepEqual(decodeVarints(encodeVarints(nums)), nums);
});

test('positions round-trip via delta encoding', () => {
  const positions = [0, 2, 3, 3 === 3 ? 5 : 0, 129, 1000];
  assert.deepEqual(decodePositions(encodePositions(positions)), positions);
});

test('truncated varint throws', () => {
  assert.throws(() => decodeVarints(Buffer.from([0x80])), /truncated/);
});
