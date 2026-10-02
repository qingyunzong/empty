'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rational } = require('../src/rational');

test('parses and normalizes rationals', () => {
  assert.equal(Rational.from('2/4').toString(), '1/2');
  assert.equal(Rational.from('-3/-6').toString(), '1/2');
  assert.equal(Rational.from('4/-8').toString(), '-1/2');
  assert.equal(Rational.from('0.125').toString(), '1/8');
  assert.equal(Rational.from('-1.25').toString(), '-5/4');
  assert.equal(Rational.from(7).toString(), '7');
  assert.equal(Rational.from('0/5').toString(), '0');
});

test('exact arithmetic', () => {
  assert.equal(Rational.from('1/3').add(Rational.from('1/6')).toString(), '1/2');
  assert.equal(Rational.from('1/3').sub(Rational.from('1/2')).toString(), '-1/6');
  assert.equal(Rational.from('2/3').mul(Rational.from('9/4')).toString(), '3/2');
  assert.equal(Rational.from('2/3').div(Rational.from('4/5')).toString(), '5/6');
  assert.equal(Rational.from('-1/2').abs().toString(), '1/2');
});

test('floor rounds towards -infinity', () => {
  assert.equal(Rational.from('7/4').floor(), 1n);
  assert.equal(Rational.from('-7/4').floor(), -2n);
  assert.equal(Rational.from('-8/4').floor(), -2n);
});

test('rejects inexact inputs', () => {
  assert.throws(() => Rational.from(0.1), /not exactly representable/);
  assert.throws(() => Rational.from('1/0'), /zero denominator/);
});
