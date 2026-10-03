import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/fraction.js';

test('exact arithmetic, no floats', () => {
  const a = Frac.parse('1/3');
  const b = Frac.parse('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
  assert.equal(Frac.parse('-2/4').toString(), '-1/2');
  assert.equal(Frac.parse('2/-4').toString(), '-1/2');
  assert.equal(Frac.parse('0/5').toString(), '0');
});

test('parse integer number, bigint, {num,den}', () => {
  assert.equal(Frac.parse(3).toString(), '3');
  assert.equal(Frac.parse(7n).toString(), '7');
  assert.equal(Frac.parse({ num: '6', den: '8' }).toString(), '3/4');
});

test('reject floats and bad input', () => {
  assert.throws(() => Frac.parse(0.5), /E_INPUT|non-integer/);
  assert.throws(() => Frac.parse('1/0'), /zero denominator/);
  assert.throws(() => Frac.parse('abc'), /invalid rational/);
});

test('comparison and sign', () => {
  assert.ok(Frac.parse('1/3').gt(Frac.parse('1/4')));
  assert.ok(Frac.parse('2/4').eq(Frac.parse('1/2')));
  assert.equal(Frac.parse('-3/2').sign(), -1);
});
