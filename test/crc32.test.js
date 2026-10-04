import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';

test('crc32 matches well-known vectors', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('hello world')), 0x0d4a1185);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});
