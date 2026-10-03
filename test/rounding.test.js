import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational } from '../src/rational.js';
import { roundTo } from '../src/rounding.js';

const r = (s, scale, mode) => roundTo(Rational.fromDecimal(s), scale, mode);

test('HALF_EVEN boundary: 0.005 rounds to 0.00 (0 is even)', () => {
  const { rounded, remainder } = r('0.005', 2, 'HALF_EVEN');
  assert.equal(rounded.toDecimalFixed(2), '0.00');
  assert.equal(remainder.toDecimal(), '0.005');
});

test('HALF_EVEN boundary: 0.015 rounds to 0.02 (2 is even)', () => {
  const { rounded } = r('0.015', 2, 'HALF_EVEN');
  assert.equal(rounded.toDecimalFixed(2), '0.02');
});

test('HALF_EVEN boundary: 0.025 rounds to 0.02, 0.035 to 0.04', () => {
  assert.equal(r('0.025', 2, 'HALF_EVEN').rounded.toDecimalFixed(2), '0.02');
  assert.equal(r('0.035', 2, 'HALF_EVEN').rounded.toDecimalFixed(2), '0.04');
});

test('HALF_UP boundary: 0.005 rounds to 0.01', () => {
  assert.equal(r('0.005', 2, 'HALF_UP').rounded.toDecimalFixed(2), '0.01');
  assert.equal(r('0.004', 2, 'HALF_UP').rounded.toDecimalFixed(2), '0.00');
});

test('DOWN truncates toward zero', () => {
  assert.equal(r('0.019', 2, 'DOWN').rounded.toDecimalFixed(2), '0.01');
  assert.equal(r('-0.019', 2, 'DOWN').rounded.toDecimalFixed(2), '-0.01');
});

test('rounded + remainder == input (conservation of the rounding step)', () => {
  for (const s of ['100.005', '0.001', '999.999', '12.34']) {
    for (const mode of ['HALF_UP', 'HALF_EVEN', 'DOWN']) {
      const { rounded, remainder } = r(s, 2, mode);
      assert.equal(rounded.add(remainder).cmp(Rational.fromDecimal(s)), 0, `${s} ${mode}`);
    }
  }
});

test('unknown rounding mode raises E_ROUND', () => {
  assert.throws(() => r('1.00', 2, 'CEILING'), /E_ROUND/);
});

test('literals exceeding precision limits raise E_LEX', () => {
  assert.throws(() => Rational.fromDecimal('1.12345', 'money'), /E_LEX/);
  assert.throws(() => Rational.fromDecimal('1.123', 'units'), /E_LEX/);
  assert.throws(() => Rational.fromDecimal('1.5', 'bps'), /E_LEX/);
  assert.equal(Rational.fromDecimal('1.1234', 'money').toDecimal(), '1.1234');
});
