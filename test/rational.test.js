import test from 'node:test';
import assert from 'node:assert/strict';
import { Rational, RationalError } from '../src/rational.js';

test('parses integers, decimals and fractions exactly', () => {
  assert.equal(Rational.parse(3).toString(), '3');
  assert.equal(Rational.parse('3/4').toString(), '3/4');
  assert.equal(Rational.parse('6/8').toString(), '3/4');
  assert.equal(Rational.parse('1.5').toString(), '3/2');
  assert.equal(Rational.parse(0.1).toString(), '1/10');
  assert.equal(Rational.parse('-2/5').toString(), '-2/5');
  assert.equal(Rational.parse('2/-5').toString(), '-2/5');
  assert.equal(Rational.parse('1e-3').toString(), '1/1000');
  assert.equal(Rational.parse('0').toString(), '0');
});

test('rejects invalid rationals with E_RATIONAL', () => {
  for (const bad of ['abc', '1/0', '1.2.3', NaN, Infinity, null, undefined, {}, [], true, '']) {
    assert.throws(() => Rational.parse(bad), (e) => e instanceof RationalError && e.code === 'E_RATIONAL');
  }
});

test('arithmetic and comparison are exact', () => {
  const third = Rational.parse('1/3');
  const sixth = Rational.parse('1/6');
  assert.equal(third.add(sixth).toString(), '1/2');
  assert.equal(third.sub(sixth).toString(), '1/6');
  assert.equal(Rational.parse('0.1').add(Rational.parse('0.2')).toString(), '3/10');
  assert.ok(Rational.parse('2/3').gt(Rational.parse('1/3')));
  assert.ok(Rational.parse('2/3').gte(Rational.parse('4/6')));
  assert.ok(Rational.parse('-1').isNegative());
});
