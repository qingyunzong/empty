import { describe, test } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { keyBetween } from '../src/position.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('keyBetween', () => {
  test('unbounded keys are ordered', () => {
    const k1 = keyBetween(null, null);
    const k2 = keyBetween(k1, null);
    const k0 = keyBetween(null, k1);
    ok(k0 < k1, `${k0} < ${k1}`);
    ok(k1 < k2, `${k1} < ${k2}`);
  });

  test('result is strictly between bounds, including adjacent digits', () => {
    const cases: [string, string][] = [
      ['0', '1'],
      ['0', '0i'],
      ['a', 'b'],
      ['az', 'b'],
      ['zz', 'zz1'],
      ['abc', 'abd'],
    ];
    for (const [a, b] of cases) {
      const k = keyBetween(a, b);
      ok(a < k, `${a} < ${k}`);
      ok(k < b, `${k} < ${b}`);
    }
  });

  test('repeated midpoint insertion stays strictly ordered', () => {
    const rand = mulberry32(7);
    const keys: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 500; i++) {
      const idx = Math.floor(rand() * (keys.length + 1));
      const prev = idx > 0 ? keys[idx - 1]! : null;
      const next = idx < keys.length ? keys[idx]! : null;
      keys.splice(idx, 0, keyBetween(prev, next));
    }
    for (let i = 1; i < keys.length; i++) {
      ok(keys[i - 1]! < keys[i]!, `keys[${i - 1}] < keys[${i}]`);
    }
    equal(new Set(keys).size, keys.length);
  });
});
