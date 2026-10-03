import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction } from '../src/fraction.js';

test('parses integers, fractions, decimals, objects', () => {
  assert.equal(Fraction.parse(3).toString(), '3');
  assert.equal(Fraction.parse('3/4').toString(), '3/4');
  assert.equal(Fraction.parse('-6/8').toString(), '-3/4');
  assert.equal(Fraction.parse('1.5').toString(), '3/2');
  assert.equal(Fraction.parse({ num: 4, den: 6 }).toString(), '2/3');
});

test('exact arithmetic', () => {
  assert.equal(Fraction.parse('1/3').add('1/6').toString(), '1/2');
  assert.equal(Fraction.parse('2/5').mul('5/8').toString(), '1/4');
  assert.equal(Fraction.parse('1/2').div('3/4').toString(), '2/3');
  assert.ok(Fraction.parse('1/3').lt('2/5'));
  assert.ok(Fraction.parse('2/4').eq('1/2'));
});

test('denominator zero throws', () => {
  assert.throws(() => Fraction.parse('1/0'), /denominator is zero/);
  assert.throws(() => new Fraction(1n, 0n), /denominator is zero/);
});

test('floor and ceil', () => {
  assert.equal(Fraction.parse('7/2').ceil(), 4n);
  assert.equal(Fraction.parse('7/2').floor(), 3n);
  assert.equal(Fraction.parse('-7/2').floor(), -4n);
  assert.equal(Fraction.parse('4').ceil(), 4n);
});
