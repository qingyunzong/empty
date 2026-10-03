import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational } from '../src/rational.js';
import { formatQuantity } from '../src/format.js';

test('parses integers, fractions and decimals', () => {
  assert.equal(Rational.parse('3').toString(), '3');
  assert.equal(Rational.parse('-3/4').toString(), '-3/4');
  assert.equal(Rational.parse('6/8').toString(), '3/4');
  assert.equal(Rational.parse('0.5').toString(), '1/2');
  assert.equal(Rational.parse('0.000001').toString(), '1/1000000');
  assert.equal(Rational.parse('.25').toString(), '1/4');
  assert.equal(Rational.parse('-0.5').toString(), '-1/2');
  assert.equal(Rational.parse(2n).toString(), '2');
});

test('rejects invalid rationals with E_RATIONAL', () => {
  for (const bad of ['abc', '1/0', '1.2.3', '', '1/2/3', NaN, Infinity]) {
    assert.throws(() => Rational.parse(bad), (e) => e.code === 'E_RATIONAL');
  }
  assert.throws(() => new Rational(1n, 0n), (e) => e.code === 'E_RATIONAL');
});

test('exact arithmetic', () => {
  assert.equal(Rational.parse('1/3').add('1/6').toString(), '1/2');
  assert.equal(Rational.parse('1/3').mul('3/7').toString(), '1/7');
  assert.equal(Rational.parse('1/2').sub('3/2').toString(), '-1');
  assert.equal(Rational.parse('2/3').div('4/5').toString(), '5/6');
  assert.equal(Rational.parse('0.1').add('0.2').toString(), '3/10'); // no float drift
  assert.throws(() => Rational.parse('1').div('0'), (e) => e.code === 'E_RATIONAL');
});

test('formatQuantity: exact fraction, decimal and error bound', () => {
  const third = formatQuantity('1/3', 2);
  assert.equal(third.value, '0.33');
  assert.equal(third.exact, '1/3');
  assert.equal(third.error, '1/300');
  assert.equal(third.errorBound, '1/200');
  assert.ok(third.withinBound);

  const tie = formatQuantity('1/2', 0);
  assert.equal(tie.value, '1');
  assert.equal(tie.error, '1/2');
  assert.equal(tie.errorBound, '1/2');
  assert.ok(tie.withinBound); // error may equal but never exceed half a unit

  const exact = formatQuantity('-7/2', 1);
  assert.equal(exact.value, '-3.5');
  assert.equal(exact.error, '0');

  const two3 = formatQuantity('2/3', 2);
  assert.equal(two3.value, '0.67');
  assert.equal(two3.error, '1/300');
});

test('formatQuantity: error never exceeds half a unit (sweep)', () => {
  for (let n = 1n; n <= 60n; n++) {
    for (let d = 1n; d <= 37n; d++) {
      for (const dec of [0, 1, 2, 3, 5]) {
        const r = formatQuantity(new Rational(n * (n % 2n === 0n ? 1n : -1n), d), dec);
        assert.ok(r.withinBound, `${n}/${d} @ ${dec}`);
      }
    }
  }
});
