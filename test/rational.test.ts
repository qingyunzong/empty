import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/rational.js';

test('normalization: reduced, positive denominator', () => {
  const f = Frac.make(6n, -8n);
  assert.equal(f.num, -3n);
  assert.equal(f.den, 4n);
  assert.equal(Frac.make(0n, 5n).den, 1n);
});

test('arithmetic is exact', () => {
  const a = Frac.parse('1/3');
  const b = Frac.parse('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(a.neg().toString(), '-1/3');
});

test('exact comparison, no epsilon anywhere', () => {
  const x = Frac.parse('1/3');
  const y = Frac.parse('333333333333333333333333/1000000000000000000000000');
  assert.equal(x.cmp(y), 1); // distinct rationals are never "close enough"
  assert.equal(Frac.parse('2/6').cmp(Frac.parse('1/3')), 0);
  assert.equal(Frac.parse('-1/2').sign(), -1);
  assert.equal(Frac.ZERO.sign(), 0);
});

test('parsing: integers, decimals, fractions, bigint, safe-int numbers', () => {
  assert.equal(Frac.from(5).toString(), '5');
  assert.equal(Frac.from(-7n).toString(), '-7');
  assert.equal(Frac.parse('0.125').toString(), '1/8');
  assert.equal(Frac.parse('-2.5').toString(), '-5/2');
  assert.equal(Frac.parse(' 3/4 ').toString(), '3/4');
  assert.throws(() => Frac.from(0.1), /safe integer/);
  assert.throws(() => Frac.parse('1/0'));
  assert.throws(() => Frac.parse('abc'));
});
