import test from 'node:test';
import assert from 'node:assert/strict';
import { Rat, floorDiv } from '../src/rational.js';
import { quantize, roundHalfUp } from '../src/quantize.js';

test('rational parsing and normalization', () => {
  assert.equal(Rat.of('3/4').toString(), '3/4');
  assert.equal(Rat.of('-5/10').toString(), '-1/2');
  assert.equal(Rat.of('6/3').toString(), '2');
  assert.equal(Rat.of(0.5).toString(), '1/2');
  assert.equal(Rat.of('1.25').toString(), '5/4');
  assert.equal(Rat.of('2/-4').toString(), '-1/2');
  assert.equal(Rat.of('0/5').toString(), '0');
  assert.throws(() => Rat.of('1/0'));
  assert.throws(() => Rat.of('abc'));
});

test('rational arithmetic', () => {
  const half = Rat.of('1/2');
  const third = Rat.of('1/3');
  assert.equal(half.add(third).toString(), '5/6');
  assert.equal(half.sub(third).toString(), '1/6');
  assert.equal(half.mul(third).toString(), '1/6');
  assert.equal(half.div(third).toString(), '3/2');
  assert.equal(half.neg().toString(), '-1/2');
  assert.equal(half.neg().abs().toString(), '1/2');
  assert.equal(Rat.of('-2/3').cmp(Rat.of('-1/2')), -1);
  assert.ok(Rat.of('2/4').eq(Rat.of('1/2')));
});

test('floorDiv rounds toward negative infinity', () => {
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, -2n), -4n);
  assert.equal(floorDiv(-7n, -2n), 3n);
  assert.equal(floorDiv(-6n, 2n), -3n);
});

test('roundHalfUp: halves go up', () => {
  assert.equal(roundHalfUp(Rat.of('1/2')), 1n);
  assert.equal(roundHalfUp(Rat.of('3/2')), 2n);
  assert.equal(roundHalfUp(Rat.of('5/2')), 3n);
  assert.equal(roundHalfUp(Rat.of('-1/2')), 0n);
  assert.equal(roundHalfUp(Rat.of('-3/2')), -1n);
  assert.equal(roundHalfUp(Rat.of('7/4')), 2n);
  assert.equal(roundHalfUp(Rat.of('5/4')), 1n);
});

test('quantize to 10^-k with half up', () => {
  assert.equal(quantize(Rat.of('1/2'), 0).toString(), '1');
  assert.equal(quantize(Rat.of('1/8'), 2).toString(), '13/100'); // 12.5 -> 13
  assert.equal(quantize(Rat.of('1/2000'), 3).toString(), '1/1000'); // 0.5 -> 1
  assert.equal(quantize(Rat.of('7/6'), 2).toString(), '117/100');
  assert.equal(quantize(Rat.of('0'), 5).toString(), '0');
  assert.equal(quantize(Rat.of('-1/2'), 0).toString(), '0');
});
