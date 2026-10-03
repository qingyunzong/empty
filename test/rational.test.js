import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rat, rat, roundToScaledInt, formatScaledInt, roundingErrorBound,
} from '../src/rational.js';
import { QError } from '../src/errors.js';

test('arithmetic is exact and normalized', () => {
  assert.equal(rat('1/2').add(rat('1/3')).toString(), '5/6');
  assert.equal(rat('2/4').toString(), '1/2');
  assert.equal(rat('-2/-4').toString(), '1/2');
  assert.equal(rat('2/-4').toString(), '-1/2');
  assert.equal(rat('1/2').mul(rat('2/3')).toString(), '1/3');
  assert.equal(rat('1/2').div(rat('3/4')).toString(), '2/3');
  assert.equal(rat('1/2').sub(rat('3/2')).toString(), '-1');
  assert.equal(rat('5/2').cmp(rat('5/3')), 1);
});

test('parses integers, decimals, fractions, and {num, den}', () => {
  assert.equal(rat(3).toString(), '3');
  assert.equal(rat('0.125').toString(), '1/8');
  assert.equal(rat('-1.25').toString(), '-5/4');
  assert.equal(rat('1e-3').toString(), '1/1000');
  assert.equal(rat('-3/4').toString(), '-3/4');
  assert.equal(rat({ num: 6, den: 8 }).toString(), '3/4');
  assert.equal(rat({ num: '5' }).toString(), '5');
});

test('zero denominator raises E_RATIONAL', () => {
  for (const bad of ['1/0', { num: 1, den: 0 }, { num: 1, den: '0' }]) {
    assert.throws(() => rat(bad), (e) => e instanceof QError && e.code === 'E_RATIONAL');
  }
  assert.throws(() => rat('1/2').div(rat(0)), (e) => e.code === 'E_RATIONAL');
});

test('invalid strings raise E_RATIONAL', () => {
  for (const bad of ['abc', '1/2/3', '1.2.3', '', '1/']) {
    assert.throws(() => rat(bad), (e) => e.code === 'E_RATIONAL');
  }
});

test('rounding is half away from zero with exact error bound', () => {
  assert.equal(formatScaledInt(roundToScaledInt(rat('1/8'), 2), 2), '0.13');
  assert.equal(formatScaledInt(roundToScaledInt(rat('-1/8'), 2), 2), '-0.13');
  assert.equal(formatScaledInt(roundToScaledInt(rat('1/3'), 2), 2), '0.33');
  assert.equal(formatScaledInt(roundToScaledInt(rat('1/4'), 2), 2), '0.25');
  assert.equal(formatScaledInt(roundToScaledInt(rat('5/2'), 0), 0), '3');
  assert.equal(formatScaledInt(roundToScaledInt(rat('-5/2'), 0), 0), '-3');
  assert.equal(formatScaledInt(roundToScaledInt(rat('1/2000'), 3), 3), '0.001');
  assert.equal(roundingErrorBound(3).toString(), '1/2000');
  assert.equal(roundingErrorBound(0).toString(), '1/2');
});
