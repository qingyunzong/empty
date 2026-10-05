import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { digestCanonical, digestBytes } from '../src/digest.js';
import { encodeCanonical, obj } from '../src/encoder.js';
import type { CanonicalValue } from '../src/types.js';

test('digest is independent of object insertion order', () => {
  const forward = obj([['alpha', 1], ['beta', 2], ['gamma', [3, 4]]]);
  const reverse = obj([['gamma', [3, 4]], ['beta', 2], ['alpha', 1]]);
  const mixed = obj([['beta', 2], ['alpha', 1], ['gamma', [3, 4]]]);
  const d = digestCanonical(forward);
  assert.equal(digestCanonical(reverse), d);
  assert.equal(digestCanonical(mixed), d);
});

test('digest is independent of plain-object literal order', () => {
  const a = digestCanonical({ x: 1, y: 2, z: { nested: 1 } });
  const b = digestCanonical({ z: { nested: 1 }, y: 2, x: 1 });
  assert.equal(a, b);
});

test('digest equals sha256 of the canonical encoding', () => {
  const value: CanonicalValue = { msg: Uint8Array.of(104, 101, 108, 108, 111), n: 42, raw: Uint8Array.of(1, 2, 3) };
  const expected = createHash('sha256').update(encodeCanonical(value)).digest('hex');
  assert.equal(digestCanonical(value), expected);
  assert.equal(digestBytes(encodeCanonical(value)), expected);
});

test('known-answer digest for a fixed value', () => {
  // canonical encoding of {a: 1} is 6f 01 01 61 69 02
  const expected = createHash('sha256')
    .update(Uint8Array.from([0x6f, 0x01, 0x01, 0x61, 0x69, 0x02]))
    .digest('hex');
  assert.equal(digestCanonical({ a: 1 }), expected);
});

test('different values produce different digests', () => {
  assert.notEqual(digestCanonical({ a: 1 }), digestCanonical({ a: 2 }));
  assert.notEqual(digestCanonical([1, 2]), digestCanonical([2, 1]));
  assert.notEqual(digestCanonical(Uint8Array.of(1)), digestCanonical(Uint8Array.of(2)));
});

test('nested objects are canonicalized at every depth', () => {
  const a = digestCanonical({ outer: obj([['b', 1], ['a', 2]]), z: 0 });
  const b = digestCanonical({ z: 0, outer: obj([['a', 2], ['b', 1]]) });
  assert.equal(a, b);
});
