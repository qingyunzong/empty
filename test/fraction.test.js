'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Frac } = require('../src/fraction.js');

test('parses integers, decimals and p/q strings exactly', () => {
  assert.equal(Frac.from(3).toString(), '3');
  assert.equal(Frac.from('3/4').toString(), '3/4');
  assert.equal(Frac.from('6/8').toString(), '3/4');
  assert.equal(Frac.from(0.1).toString(), '1/10');
  assert.equal(Frac.from('-2/6').toString(), '-1/3');
  assert.equal(Frac.from('2/-6').toString(), '-1/3');
  assert.equal(Frac.from('1.25').toString(), '5/4');
});

test('arithmetic stays exact', () => {
  assert.equal(Frac.from('1/3').add('1/6').toString(), '1/2');
  assert.equal(Frac.from('1/2').sub('3/4').toString(), '-1/4');
  assert.equal(Frac.from('2/3').mul('9/4').toString(), '3/2');
  assert.equal(Frac.from('1/2').div('1/4').toString(), '2');
  assert.equal(Frac.from(0.1).add(0.2).toString(), '3/10');
});

test('rejects invalid coordinates', () => {
  assert.throws(() => Frac.from('1/0'), RangeError);
  assert.throws(() => Frac.from('abc'), SyntaxError);
  assert.throws(() => Frac.from(Number.NaN), RangeError);
  assert.throws(() => Frac.from(Infinity), RangeError);
  assert.throws(() => Frac.from(null), TypeError);
});
