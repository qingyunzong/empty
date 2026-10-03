import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Polynomial } from '../src/polynomial.js';
import { Interval } from '../src/interval.js';

test('constant and linear polynomials map intervals via endpoints', () => {
  const c = new Polynomial(['7/2']);
  assert.deepEqual(c.mapInterval(new Interval('1', '2')).toJSON(), { lo: '7/2', hi: '7/2' });
  const l = new Polynomial(['1', '2']); // 1 + 2t
  assert.deepEqual(l.mapInterval(new Interval('0', '3')).toJSON(), { lo: '1', hi: '7' });
  const neg = new Polynomial(['0', '-1']); // decreasing
  assert.deepEqual(neg.mapInterval(new Interval('1', '4')).toJSON(), { lo: '-4', hi: '-1' });
});

test('quadratic vertex inside interval is included', () => {
  // p(t) = (t-2)^2 = 4 - 4t + t^2, vertex t=2, p(2)=0
  const p = new Polynomial(['4', '-4', '1']);
  const img = p.mapInterval(new Interval('0', '5'));
  assert.deepEqual(img.toJSON(), { lo: '0', hi: '9' });
});

test('quadratic vertex outside interval uses endpoints only', () => {
  // same p, interval [3,5] entirely right of vertex 2
  const p = new Polynomial(['4', '-4', '1']);
  const img = p.mapInterval(new Interval('3', '5'));
  assert.deepEqual(img.toJSON(), { lo: '1', hi: '9' });
});

test('quadratic with rational vertex and rational coefficients', () => {
  // p(t) = 1/2 t^2 - t, vertex t = 1, p(1) = -1/2
  const p = new Polynomial(['0', '-1', '1/2']);
  const img = p.mapInterval(new Interval('0', '4'));
  assert.deepEqual(img.toJSON(), { lo: '-1/2', hi: '4' });
});

test('degree above 2 is rejected with E_CORRECTION', () => {
  try {
    new Polynomial(['1', '0', '0', '1']);
    assert.unreachable();
  } catch (e) {
    assert.equal(e.code, 'E_CORRECTION');
  }
});

test('illegal interval raises E_INTERVAL', () => {
  try {
    new Interval('5', '2');
    assert.unreachable();
  } catch (e) {
    assert.equal(e.code, 'E_INTERVAL');
  }
});
