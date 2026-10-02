import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/fraction.js';

test('normalizes gcd and sign', () => {
  assert.equal(new Frac(2n, -4n).toString(), '-1/2');
  assert.equal(new Frac(-2n, -4n).toString(), '1/2');
  assert.equal(new Frac(6n, 3n).toString(), '2');
  assert.equal(new Frac(0n, 7n).toString(), '0');
});

test('exact arithmetic', () => {
  const a = new Frac(1n, 3n);
  const b = new Frac(1n, 6n);
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(a.neg().toString(), '-1/3');
});

test('exact comparison', () => {
  assert.equal(new Frac(1n, 3n).cmp(new Frac(2n, 6n)), 0);
  assert.ok(new Frac(2n, 3n).cmp(new Frac(1n, 2n)) > 0);
  assert.ok(new Frac(-2n, 3n).cmp(new Frac(1n, 2n)) < 0);
  assert.ok(new Frac(4n, 6n).eq(new Frac(2n, 3n)));
});

test('zero denominator rejected', () => {
  assert.throws(() => new Frac(1n, 0n), RangeError);
  assert.throws(() => new Frac(1n, 2n).div(Frac.zero()), RangeError);
});

test('parse round-trips', () => {
  assert.equal(Frac.parse('-3/4').toString(), '-3/4');
  assert.equal(Frac.parse('5').toString(), '5');
  assert.throws(() => Frac.parse('1.5'), RangeError);
});
