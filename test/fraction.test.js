import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frac,
  add,
  sub,
  mul,
  div,
  cmp,
  eq,
  floorFrac,
  gcd,
} from '../src/fraction.js';

test('normalizes sign and gcd', () => {
  assert.deepEqual(frac(2n, 4n), { num: 1n, den: 2n });
  assert.deepEqual(frac(3n, -6n), { num: -1n, den: 2n });
  assert.deepEqual(frac(-3n, -6n), { num: 1n, den: 2n });
  assert.deepEqual(frac(0n, 7n), { num: 0n, den: 1n });
  assert.throws(() => frac(1n, 0n), /E_DEN_ZERO/);
});

test('arithmetic stays exact and normalized', () => {
  assert.ok(eq(add(frac(1n, 3n), frac(1n, 6n)), frac(1n, 2n)));
  assert.ok(eq(sub(frac(1n, 2n), frac(3n, 4n)), frac(-1n, 4n)));
  assert.ok(eq(mul(frac(2n, 3n), frac(9n, 4n)), frac(3n, 2n)));
  assert.ok(eq(div(frac(3n, 2n), frac(9n, 4n)), frac(2n, 3n)));
  assert.equal(cmp(frac(1n, 3n), frac(2n, 5n)), -1);
  assert.equal(cmp(frac(2n, 4n), frac(1n, 2n)), 0);
});

test('floor of rationals rounds toward negative infinity', () => {
  assert.equal(floorFrac(frac(7n, 2n)), 3n);
  assert.equal(floorFrac(frac(-7n, 2n)), -4n);
  assert.equal(floorFrac(frac(8n, 4n)), 2n);
});

test('huge fractions stay exact', () => {
  const big1 = frac(2n ** 200n - 16n, 2n ** 100n + 4n);
  const big2 = frac(2n ** 100n - 4n, 1n);
  assert.ok(eq(big1, big2)); // numerator = denominator * (2^100+4)
  const huge = mul(frac(10n ** 40n + 1n, 10n ** 20n + 3n), frac(10n ** 20n + 3n, 1n));
  assert.ok(eq(huge, frac(10n ** 40n + 1n, 1n)));
  assert.equal(gcd(10n ** 30n, 6n), 2n);
});
