import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/fraction.js';

test('normalizes sign and gcd', () => {
  assert.deepEqual(F.frac(2n, 4n), { num: 1n, den: 2n });
  assert.deepEqual(F.frac(1n, -2n), { num: -1n, den: 2n });
  assert.deepEqual(F.frac(-6n, -9n), { num: 2n, den: 3n });
  assert.deepEqual(F.frac(0n, 7n), { num: 0n, den: 1n });
});

test('rejects zero denominator', () => {
  assert.throws(() => F.frac(1n, 0n), /E_FRAC/);
});

test('exact arithmetic on huge fractions', () => {
  const a = F.frac(10n ** 40n + 1n, 10n ** 20n + 3n);
  const b = F.frac(10n ** 20n - 3n, 7n);
  const s = F.add(a, b);
  // verify by cross-multiplication
  const lhs = s.num * (10n ** 20n + 3n) * 7n;
  const rhs = s.den * ((10n ** 40n + 1n) * 7n + (10n ** 20n - 3n) * (10n ** 20n + 3n));
  assert.equal(lhs, rhs);
  assert.equal(F.gcd(s.num < 0n ? -s.num : s.num, s.den), 1n);
});

test('comparison is exact across denominators', () => {
  assert.equal(F.cmp(F.frac(1n, 3n), F.frac(333333333333333333333n, 10n ** 21n)), 1);
  assert.equal(F.cmp(F.frac(2n, 4n), F.frac(3n, 6n)), 0);
  assert.equal(F.cmp(F.frac(-1n, 2n), F.frac(1n, 10n ** 30n)), -1);
});
