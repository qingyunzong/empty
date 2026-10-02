import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac, RationalError } from '../src/rational.js';

test('parses integers, decimals, fractions and {num, den}', () => {
  assert.equal(Frac.parse(3).toString(), '3');
  assert.equal(Frac.parse('1.5').toString(), '3/2');
  assert.equal(Frac.parse('-6/8').toString(), '-3/4');
  assert.equal(Frac.parse({ num: 4, den: -6 }).toString(), '-2/3');
  assert.equal(Frac.parse(' 2/4 ').toString(), '1/2');
});

test('exact arithmetic', () => {
  const third = Frac.parse('1/3');
  const sixth = Frac.parse('1/6');
  assert.equal(third.add(sixth).toString(), '1/2');
  assert.equal(third.mul(sixth).toString(), '1/18');
  assert.equal(third.div(sixth).toString(), '2');
  assert.equal(Frac.parse('0.1').add('0.2').toString(), '3/10');
});

test('zero denominator raises E_RATIONAL', () => {
  assert.throws(() => Frac.parse('1/0'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => Frac.parse({ num: 1, den: 0 }), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => new Frac(1n, 0n), RationalError);
});

test('garbage input raises E_RATIONAL', () => {
  assert.throws(() => Frac.parse('abc'), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => Frac.parse(NaN), (e) => e.code === 'E_RATIONAL');
});
