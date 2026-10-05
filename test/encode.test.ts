import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { encodeCanonical, obj } from '../src/encoder.js';
import { CanonicalError } from '../src/errors.js';
import type { CanonicalValue } from '../src/types.js';

function hex(value: CanonicalValue): string {
  return Buffer.from(encodeCanonical(value)).toString('hex');
}

test('integer encoding uses zigzag varints', () => {
  assert.equal(hex(0), '6900');
  assert.equal(hex(1), '6902');
  assert.equal(hex(-1), '6901');
  assert.equal(hex(63), '697e');
  assert.equal(hex(-64), '697f');
  assert.equal(hex(64), '698001'); // zigzag 128 -> 0x80 0x01
  assert.equal(hex(300), '69d804'); // zigzag 600 -> 0xd8 0x04
  assert.equal(hex(2n ** 62n), '69' + '80'.repeat(9) + '01');
  assert.equal(hex(-(2n ** 62n)), '69ffffffffffffffff7f');
});

test('bigint and number encode identically for the same integer', () => {
  assert.equal(hex(42n), hex(42));
  assert.equal(hex(-7n), hex(-7));
});

test('rejects non-integer and unsafe numbers', () => {
  assert.throws(() => encodeCanonical(1.5), CanonicalError);
  assert.throws(() => encodeCanonical(NaN), CanonicalError);
  assert.throws(() => encodeCanonical(Infinity), CanonicalError);
  assert.throws(() => encodeCanonical(2 ** 53), CanonicalError);
  assert.throws(() => encodeCanonical(2n ** 63n), CanonicalError);
  assert.throws(() => encodeCanonical(-(2n ** 63n) - 1n), CanonicalError);
});

test('byte string encoding carries a length prefix', () => {
  assert.equal(hex(Uint8Array.of(1, 2, 3)), '6203010203');
  assert.equal(hex(Uint8Array.of()), '6200');
});

test('array encoding concatenates elements in order', () => {
  assert.equal(hex([]), '6100');
  assert.equal(hex([1, 2]), '610269026904');
  assert.equal(hex([[1], [2, 3]]), '610261016902610269046906');
});

test('object keys are sorted by UTF-8 byte order, not insertion order', () => {
  const a = hex(obj([['b', 1], ['a', 2]]));
  const b = hex(obj([['a', 2], ['b', 1]]));
  assert.equal(a, b);
  assert.equal(a, '6f020161690401626902');
});

test('UTF-8 byte order differs from UTF-16 code unit order', () => {
  // 'z' (U+007A, byte 0x7A) sorts before 'é' (U+00E9, bytes 0xC3 0xA9),
  // and 'a' before 'aa' (prefix rule).
  const encoded = hex(obj([['é', 1], ['z', 2], ['aa', 3], ['a', 4]]));
  const expected = hex(obj([['a', 4], ['aa', 3], ['z', 2], ['é', 1]]));
  assert.equal(encoded, expected);
  // key bytes: 61, 6161, 7a, c3a9
  assert.equal(encoded, '6f04' + '0161' + '6908' + '026161' + '6906' + '017a' + '6904' + '02c3a9' + '6902');
});

test('duplicate keys are rejected', () => {
  assert.throws(
    () => obj([['a', 1], ['b', 2], ['a', 3]]),
    (err: unknown) => err instanceof CanonicalError && /duplicate object key/.test((err as Error).message),
  );
  assert.throws(() => obj([['x', 1], ['x', 1]]), /duplicate object key/);
});

test('keys with unpaired surrogates are rejected', () => {
  assert.throws(() => encodeCanonical({ '\uD800': 1 } as CanonicalValue), /unpaired surrogate/);
  assert.throws(() => encodeCanonical({ '\uDC00': 1 } as CanonicalValue), /unpaired surrogate/);
  assert.throws(() => encodeCanonical({ 'a\uD800b': 1 } as CanonicalValue), /unpaired surrogate/);
  assert.throws(() => obj([['\uD83D', 1]]), /unpaired surrogate/);
  // valid astral characters (proper surrogate pairs) are accepted
  assert.equal(hex({ '😀': 1 }), '6f0104f09f98806902');
});

test('Map and plain object inputs encode identically', () => {
  const fromMap = hex(new Map<string, CanonicalValue>([['k', [1, Uint8Array.of(9)]]]));
  const fromObj = hex({ k: [1, Uint8Array.of(9)] });
  assert.equal(fromMap, fromObj);
});

test('deeply nested values do not overflow the stack', () => {
  let value: CanonicalValue = 0;
  for (let i = 0; i < 10000; i++) value = [value];
  const bytes = encodeCanonical(value);
  assert.equal(bytes.length, 10000 * 2 + 2);
});
