import test from 'node:test';
import assert from 'node:assert/strict';
import { Rational, ZERO, ONE } from '../src/rational.js';

test('normalizes sign and reduces', () => {
  const r = new Rational(6n, -9n);
  assert.equal(r.num, -2n);
  assert.equal(r.den, 3n);
  assert.equal(new Rational(4n, 2n).toString(), '2');
});

test('exact arithmetic without floats', () => {
  const a = new Rational(1n, 3n);
  const b = new Rational(1n, 6n);
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(a.neg().toString(), '-1/3');
});

test('comparison and min/max', () => {
  const a = new Rational(2n, 3n);
  const b = new Rational(3n, 4n);
  assert.equal(a.cmp(b), -1);
  assert.equal(Rational.min(a, b).toString(), '2/3');
  assert.equal(Rational.max(a, b).toString(), '3/4');
  assert.equal(ZERO.cmp(ONE), -1);
});

test('rejects zero denominator and division by zero', () => {
  assert.throws(() => new Rational(1n, 0n), /zero denominator/);
  assert.throws(() => ONE.div(ZERO), /division by zero/);
});
