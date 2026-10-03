import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';

test('crc32 known vectors', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32('123456789'), 0xcbf43926);
  assert.equal(crc32('a'), 0xe8b7be43);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
