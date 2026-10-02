import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createPrng } from '../src/prng.js';

test('same seed produces identical stream', () => {
  const a = createPrng(42);
  const b = createPrng(42);
  for (let i = 0; i < 1000; i++) assert.equal(a.nextUint32(), b.nextUint32());
});

test('different seeds produce different streams', () => {
  const a = createPrng(1);
  const b = createPrng(2);
  const sa = Array.from({ length: 16 }, () => a.nextUint32());
  const sb = Array.from({ length: 16 }, () => b.nextUint32());
  assert.notDeepEqual(sa, sb);
});

test('outputs are uint32', () => {
  const p = createPrng(0);
  for (let i = 0; i < 100; i++) {
    const v = p.nextUint32();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});

test('invalid seeds are rejected', () => {
  for (const bad of [-1, 1.5, NaN, 2 ** 32, '42']) {
    assert.throws(() => createPrng(bad), RangeError);
  }
});

test('no Math.random or Date-based randomness in src/', () => {
  for (const f of readdirSync(new URL('../src', import.meta.url))) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('Math.random'), `${f} uses Math.random`);
    assert.ok(!/\bDate\b/.test(src), `${f} uses Date`);
  }
});
