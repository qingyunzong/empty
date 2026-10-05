import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { encodeCanonical } from '../src/encoder.js';
import { encodeRecursive } from '../src/recursive-encoder.js';
import { digestCanonical, digestBytes } from '../src/digest.js';
import { parseCanonical } from '../src/parser.js';
import type { CanonicalValue } from '../src/types.js';

function assertEncodersAgree(value: CanonicalValue, label: string): void {
  const iterative = encodeCanonical(value);
  const recursive = encodeRecursive(value);
  assert.equal(
    Buffer.from(iterative).toString('hex'),
    Buffer.from(recursive).toString('hex'),
    `encoder mismatch for ${label}`,
  );
  // digest derived from either encoder must match
  assert.equal(digestCanonical(value), digestBytes(recursive), `digest mismatch for ${label}`);
  // the parser must accept both encodings and re-encode to the same bytes
  const reparsed = parseCanonical(iterative);
  assert.equal(
    Buffer.from(encodeCanonical(reparsed as CanonicalValue)).toString('hex'),
    Buffer.from(iterative).toString('hex'),
    `round-trip mismatch for ${label}`,
  );
}

test('cross-check fixed corpus covering every type and edge case', () => {
  const corpus: Array<[string, CanonicalValue]> = [
    ['zero', 0],
    ['negative', -1],
    ['safe-int-max', Number.MAX_SAFE_INTEGER],
    ['safe-int-min', Number.MIN_SAFE_INTEGER],
    ['bigint-boundary', 2n ** 62n],
    ['bigint-negative-boundary', -(2n ** 62n)],
    ['empty-bytes', Uint8Array.of()],
    ['bytes', Uint8Array.of(0, 127, 128, 255)],
    ['empty-array', []],
    ['empty-object', {}],
    ['nested-arrays', [[[[1, 2], [3]], []], [4]]],
    ['unicode-keys', { '': 0, 'a': 1, 'é': 2, '😀': 3, '中': 4, 'z': 5 }],
    ['mixed-nesting', { list: [1, 'x'.length, [Uint8Array.of(9)]], map: new Map<string, CanonicalValue>([['k', -5]]) }],
    ['deep-object', { a: { b: { c: { d: { e: 1 } } } } }],
  ];
  for (const [label, value] of corpus) {
    assertEncodersAgree(value, label);
  }
});

test('cross-check deterministic pseudo-random corpus', () => {
  // Linear congruential generator: fully deterministic, no external deps.
  let state = 0x12345678;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const KEY_CHARS = ['a', 'b', 'z', 'é', '中', '😀', 'aa', ''];

  const randomValue = (depth: number): CanonicalValue => {
    const kind = Math.floor(rand() * (depth >= 4 ? 3 : 6));
    switch (kind) {
      case 0:
        return Math.floor(rand() * 2000) - 1000;
      case 1:
        return BigInt(Math.floor(rand() * 2 ** 40)) - 2n ** 39n;
      case 2: {
        const n = Math.floor(rand() * 8);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
        return out;
      }
      case 3: {
        const n = Math.floor(rand() * 4);
        return Array.from({ length: n }, () => randomValue(depth + 1));
      }
      default: {
        const n = Math.floor(rand() * 4);
        const entries = new Map<string, CanonicalValue>();
        for (let i = 0; i < n; i++) {
          const key = KEY_CHARS[Math.floor(rand() * KEY_CHARS.length)]! + String(i);
          entries.set(key, randomValue(depth + 1));
        }
        return entries;
      }
    }
  };

  for (let i = 0; i < 300; i++) {
    assertEncodersAgree(randomValue(0), `random case #${i}`);
  }
});

test('insertion order never changes bytes across both encoders', () => {
  const keys = ['delta', 'alpha', 'charlie', 'bravo', 'éclair', 'zebra'];
  const shuffled = [...keys].reverse();
  const a = new Map<string, CanonicalValue>(keys.map((k, i) => [k, i]));
  const b = new Map<string, CanonicalValue>(shuffled.map((k) => [k, keys.indexOf(k)]));
  assert.equal(
    Buffer.from(encodeCanonical(a)).toString('hex'),
    Buffer.from(encodeRecursive(b)).toString('hex'),
  );
  assert.equal(digestCanonical(a), digestCanonical(b));
});
