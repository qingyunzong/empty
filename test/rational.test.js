import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/rational.js';

test('exact arithmetic stays in lowest terms', () => {
  assert.deepEqual(Q.add(Q.R(1n, 6n), Q.R(1n, 3n)), Q.R(1n, 2n));
  assert.equal(Q.toString(Q.mul(Q.R(22n, 7n), Q.R(14n, 11n))), '4');
  assert.equal(Q.toString(Q.div(Q.R(3n, 4n), Q.R(9n, 8n))), '2/3');
  assert.equal(Q.toString(Q.R(6n, -8n)), '-3/4');
});

test('parsing is exact for decimals and fractions', () => {
  assert.equal(Q.toString(Q.parseDecimal('12.34')), '617/50');
  assert.equal(Q.toString(Q.parseDecimal('-0.1')), '-1/10');
  assert.equal(Q.toString(Q.parseNumDen('1', '3')), '1/3');
  assert.equal(Q.toString(Q.parseNumDen(0.3)), '3/10');
  assert.throws(() => Q.parseNumDen(1, 0), /zero/);
});

test('bankers rounding: half to even, symmetric', () => {
  const r = (n, d, dec) => Q.toString(Q.roundHalfEven(Q.R(n, d), dec).rounded);
  assert.equal(r(5n, 2n, 0), '2'); // 2.5 -> 2
  assert.equal(r(7n, 2n, 0), '4'); // 3.5 -> 4
  assert.equal(r(-5n, 2n, 0), '-2'); // -2.5 -> -2
  assert.equal(r(1n, 8n, 2), '3/25'); // 0.125 -> 0.12
  assert.equal(r(27n, 200n, 2), '7/50'); // 0.135 -> 0.14
  assert.equal(Q.formatDecimal(Q.R(1n, 8n), 2), '0.12');
  assert.equal(Q.formatDecimal(Q.R(-10005n, 1000n), 2), '-10.00'); // -10.005 tie -> even
  assert.equal(Q.formatDecimal(Q.R(-10015n, 1000n), 2), '-10.02'); // -10.015 tie -> even up
});

test('rounding error never exceeds the stated bound', () => {
  const cases = [Q.R(1n, 3n), Q.R(22n, 7n), Q.R(-7n, 9n), Q.R(123456789n, 977n)];
  for (const v of cases) {
    for (const dec of [0, 2, 5]) {
      const { error, bound } = Q.roundHalfEven(v, dec);
      assert.ok(Q.cmp(error, bound) <= 0, `error ${Q.toString(error)} <= bound ${Q.toString(bound)}`);
    }
  }
  const tie = Q.roundHalfEven(Q.R(5n, 2n), 0);
  assert.equal(Q.toString(tie.error), '1/2');
  assert.equal(Q.toString(tie.bound), '1/2');
});
