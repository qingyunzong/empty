import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { crc32 } from '../src/crc32.js';

test('crc32 matches zlib.crc32', () => {
  assert.equal(crc32(Buffer.from('')), zlibCrc32(Buffer.from('')));
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  for (let i = 0; i < 20; i += 1) {
    const buf = randomBytes(1 + Math.floor(Math.random() * 512));
    assert.equal(crc32(buf), zlibCrc32(buf));
  }
});
