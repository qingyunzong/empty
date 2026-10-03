import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { uvarintEncode, uvarintDecode, zigzagEncode, zigzagDecode } from '../src/encoding.js';
import { crc32 } from '../src/crc32.js';

test('uvarint roundtrip', () => {
  const cases = [0, 1, 127, 128, 300, 16384, 2 ** 21, 2 ** 32, 2 ** 53 - 1];
  for (const n of cases) {
    const buf = uvarintEncode(n);
    const { value, offset } = uvarintDecode(buf, 0);
    assert.equal(value, n);
    assert.equal(offset, buf.length);
  }
});

test('zigzag roundtrip', () => {
  const cases = [0, -1, 1, -2, 2, -123456789, 123456789, -(2 ** 40), 2 ** 40];
  for (const n of cases) {
    assert.equal(zigzagDecode(zigzagEncode(n)), n);
  }
});

test('crc32 known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('crc32 matches zlib.crc32 when available', () => {
  if (typeof zlib.crc32 !== 'function') return;
  const data = Buffer.from('offline inspection records, chunk payload bytes');
  assert.equal(crc32(data), zlib.crc32(data));
});

test('crc32 streaming composes', () => {
  const a = Buffer.from('first-part-');
  const b = Buffer.from('second-part');
  assert.equal(crc32(b, crc32(a)), crc32(Buffer.concat([a, b])));
});
