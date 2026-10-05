import { test } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { Rational } from '../src/rational.js';

test('normalizes to lowest terms with positive denominator', () => {
  equal(Rational.parse('2/4').toString(), '1/2');
  equal(Rational.parse('6/-8').toString(), '-3/4');
  equal(Rational.parse('-6/-8').toString(), '3/4');
  equal(Rational.parse('5/1').toString(), '5');
  equal(Rational.parse('0/7').toString(), '0');
});

test('parses integers, decimals and fractions exactly', () => {
  equal(Rational.of(0.1).toString(), '1/10');
  equal(Rational.of('1.25').toString(), '5/4');
  equal(Rational.of('-0.75').toString(), '-3/4');
  equal(Rational.of('42').toString(), '42');
  equal(Rational.of(7n).toString(), '7');
  equal(Rational.of('.5').toString(), '1/2');
});

test('comparison is exact across denominators', () => {
  ok(Rational.parse('1/3').compare('2/7') > 0);
  ok(Rational.parse('2/6').compare('1/3') === 0);
  ok(Rational.parse('-3/4').compare('-2/3') < 0);
  ok(Rational.parse('355/113').compare('3.14159') > 0);
});

test('bigint exactness beyond float53 precision', () => {
  const a = Rational.of(9007199254740993n);
  const b = Rational.of(9007199254740992n);
  ok(a.compare(b) > 0);
  ok(!a.equals(b));
});

test('equality and toString round-trip', () => {
  ok(Rational.parse('4/10').equals('2/5'));
  ok(Rational.parse('4/10').equals(Rational.parse('0.4')));
  equal(Rational.parse('-7/3').toString(), '-7/3');
});

test('rejects invalid input', () => {
  throws(() => Rational.parse('1/0'));
  throws(() => Rational.parse('abc'));
  throws(() => Rational.of(Number.NaN));
  throws(() => Rational.of(Number.POSITIVE_INFINITY));
});
