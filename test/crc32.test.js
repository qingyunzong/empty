import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';

test('crc32 known vectors', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.from('hello')), 0x3610A686);
  assert.equal(crc32(Buffer.from('{"records":[]}')), crc32(Buffer.from('{"records":[]}')));
});
