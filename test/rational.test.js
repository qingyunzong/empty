import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational } from '../src/rational.js';
import { roundToString, roundingErrorBound } from '../src/rounding.js';

test('parses integers, fractions and decimals exactly', () => {
  assert.equal(Rational.from('3/4').toString(), '3/4');
  assert.equal(Rational.from('-6/8').toString(), '-3/4');
  assert.equal(Rational.from('5').toString(), '5');
  assert.equal(Rational.from('1.25').toString(), '5/4');
  assert.equal(Rational.from('-0.5').toString(), '-1/2');
  assert.equal(Rational.from(7).toString(), '7');
});

test('arithmetic is exact', () => {
  const a = Rational.from('1/3');
  const b = Rational.from('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
});

test('zero denominator raises E_RATIONAL', () => {
  assert.throws(() => Rational.from('1/0'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => Rational.from('1').div(Rational.from('0')), (e) => e.code === 'E_RATIONAL');
  try {
    Rational.from('1/0');
    assert.unreachable();
  } catch (e) {
    assert.equal(e.code, 'E_RATIONAL');
  }
});

test('rounding half away from zero with exact error bound', () => {
  assert.equal(roundToString(Rational.from('1/3'), 2), '0.33');
  assert.equal(roundToString(Rational.from('2/3'), 2), '0.67');
  assert.equal(roundToString(Rational.from('5/2'), 0), '3');
  assert.equal(roundToString(Rational.from('-5/2'), 0), '-3');
  assert.equal(roundToString(Rational.from('1.005'), 2), '1.01');
  assert.equal(roundToString(Rational.from('7'), 3), '7.000');
  assert.equal(roundingErrorBound(3).toString(), '1/2000');
  assert.equal(roundingErrorBound(0).toString(), '1/2');
});
