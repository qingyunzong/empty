import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/fraction.js';
import { bankersRound, formatDecimal } from '../src/rounding.js';

const round = (n, d, s) => bankersRound(new Frac(BigInt(n), BigInt(d)), s).rounded.toString();

test('ties round to even (bankers)', () => {
  assert.equal(round(5, 2, 0), '2');
  assert.equal(round(7, 2, 0), '4');
  assert.equal(round(-5, 2, 0), '-2');
  assert.equal(round(-7, 2, 0), '-4');
  assert.equal(round(125, 1000, 2), '3/25'); // 0.125 -> 0.12
  assert.equal(round(135, 1000, 2), '7/50'); // 0.135 -> 0.14
  assert.equal(round(1, 4, 1), '1/5'); // 0.25 -> 0.2
  assert.equal(round(3, 4, 1), '4/5'); // 0.75 -> 0.8
});

test('non-tie rounds to nearest', () => {
  assert.equal(round(1, 3, 2), '33/100');
  assert.equal(round(2, 3, 2), '67/100');
  assert.equal(round(-2, 3, 2), '-67/100');
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('actual error never exceeds the stated bound (random)', () => {
  const rand = mulberry32(20261002);
  for (let i = 0; i < 2000; i += 1) {
    const num = BigInt(Math.floor(rand() * 2_000_000) - 1_000_000);
    const den = BigInt(1 + Math.floor(rand() * 9999));
    const scale = Math.floor(rand() * 5);
    const { rounded, error, bound } = bankersRound(new Frac(num, den), scale);
    assert.ok(error.cmp(bound) <= 0, `error ${error} > bound ${bound}`);
    const factor = 10n ** BigInt(scale);
    assert.equal((rounded.num * factor) % rounded.den, 0n, 'rounded value must be a multiple of the quantum');
  }
});

test('formatDecimal renders scaled values', () => {
  assert.equal(formatDecimal(new Frac(-2450n), 2), '-2450.00');
  assert.equal(formatDecimal(new Frac(1n, 5n), 2), '0.20');
  assert.equal(formatDecimal(new Frac(3n), 0), '3');
  assert.throws(() => formatDecimal(new Frac(1n, 3n), 2), RangeError);
});
