import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';

test('crc32 known vectors', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('hello world')), 0x0d4a1185);
});

test('crc32 is additive across buffers', () => {
  const a = Buffer.from('1234');
  const b = Buffer.from('56789');
  assert.equal(crc32(a, b), crc32(Buffer.from('123456789')));
});
