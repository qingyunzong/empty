import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational, isqrt, isPerfectSquare, squarefreePart, gcd } from '../src/index.js';

test('Rational: normalization and arithmetic', () => {
  assert.equal(Rational.from('3/6').toString(), '1/2');
  assert.equal(Rational.from('-2/-4').toString(), '1/2');
  assert.equal(Rational.from('2/-4').toString(), '-1/2');
  assert.equal(Rational.from(5).toString(), '5');
  assert.equal(Rational.from('0.75').toString(), '3/4');
  assert.equal(Rational.from('-1.25').toString(), '-5/4');
  assert.equal(Rational.from('1/3').add('1/6').toString(), '1/2');
  assert.equal(Rational.from('2/3').mul('9/4').toString(), '3/2');
  assert.equal(Rational.from('1/2').sub('3/2').toString(), '-1');
  assert.equal(Rational.from('3/4').div('9/8').toString(), '2/3');
  assert.equal(Rational.from('5/2').cmp('5/3'), 1);
  assert.equal(Rational.from('-7/3').sign(), -1);
  assert.ok(Rational.from('0/9').isZero());
});

test('gcd / isqrt / perfect squares', () => {
  assert.equal(gcd(12n, 18n), 6n);
  assert.equal(gcd(-12n, 18n), 6n);
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(2n), 1n);
  assert.equal(isqrt(99n), 9n);
  assert.equal(isqrt(100n), 10n);
  assert.equal(isqrt(101n), 10n);
  const big = 10n ** 30n + 12345n;
  assert.equal(isqrt(big), 10n ** 15n);
  assert.equal(isPerfectSquare(144n), 12n);
  assert.equal(isPerfectSquare(145n), null);
});

test('squarefreePart extracts square factors', () => {
  assert.deepEqual(squarefreePart(48n), { root: 4n, squarefree: 3n });
  assert.deepEqual(squarefreePart(8n), { root: 2n, squarefree: 2n });
  assert.deepEqual(squarefreePart(7n), { root: 1n, squarefree: 7n });
  assert.deepEqual(squarefreePart(1024n), { root: 32n, squarefree: 1n });
  assert.deepEqual(squarefreePart(2n ** 20n * 3n), { root: 1024n, squarefree: 3n });
});
