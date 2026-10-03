import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction } from '../src/fraction.js';

test('normalizes sign and gcd', () => {
  assert.equal(new Fraction(2n, 4n).toString(), '1/2');
  assert.equal(new Fraction(2n, -4n).toString(), '-1/2');
  assert.equal(new Fraction(-2n, -4n).toString(), '1/2');
  assert.equal(new Fraction(0n, 7n).toString(), '0');
  assert.equal(new Fraction(6n, 3n).toString(), '2');
});

test('exact arithmetic', () => {
  assert.equal(Fraction.from('1/2').add('1/3').toString(), '5/6');
  assert.equal(Fraction.from('1/2').sub('2/3').toString(), '-1/6');
  assert.equal(Fraction.from('2/3').mul('9/4').toString(), '3/2');
  assert.equal(Fraction.from('2/3').div('4/5').toString(), '5/6');
  assert.equal(Fraction.from('3/4').neg().toString(), '-3/4');
});

test('comparison and sign', () => {
  assert.equal(Fraction.from('1/3').cmp('2/7'), 1);
  assert.equal(Fraction.from('2/6').cmp('1/3'), 0);
  assert.equal(Fraction.from('-1/3').sign(), -1);
  assert.ok(Fraction.from('0').isZero());
});

test('parses integers, strings, pairs, objects; rejects floats and junk', () => {
  assert.equal(Fraction.from(5).toString(), '5');
  assert.equal(Fraction.from('7/3').toString(), '7/3');
  assert.equal(Fraction.from([7, 3]).toString(), '7/3');
  assert.equal(Fraction.from({ num: 7, den: 3 }).toString(), '7/3');
  assert.equal(Fraction.from({ num: '8' }).toString(), '8');
  assert.throws(() => Fraction.from(0.5), /E_PARSE|not a rational/);
  assert.throws(() => Fraction.from('abc'), /invalid integer/);
  assert.throws(() => Fraction.from('1/0'), /zero denominator/);
});
