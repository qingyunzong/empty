import test from 'node:test';
import assert from 'node:assert/strict';
import { CouponEngine } from '../src/engine';

test('single order end-to-end with prereq and mutex', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 10000);
  e.addCoupon({ id: 'A', kind: 'amount', value: 1 });
  e.addCoupon({ id: 'B', kind: 'amount', value: 5000, prereq: 'A' });
  e.addCoupon({ id: 'C', kind: 'percent', value: 50, mutexGroup: 'g' });
  e.addCoupon({ id: 'D', kind: 'percent', value: 40, mutexGroup: 'g' });
  const r = e.solve();
  assert.equal(r.status, 'optimal');
  // best: A+B+C -> 10000-1-5000 = 4999, then 50% off: discount floor(2499.5) = 2499
  assert.equal(r.orderAmounts['o1'], 2500);
  assert.deepEqual(r.ownership['A'], ['o1']);
  assert.deepEqual(r.ownership['B'], ['o1']);
  assert.deepEqual(r.ownership['C'], ['o1']);
  assert.deepEqual(r.ownership['D'], []);
});

test('settle locks the payment; refund revokes and reassigns the rest', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 1000);
  e.addOrder('o2', 2000);
  e.addCoupon({ id: 'c1', kind: 'percent', value: 50 }); // saves most on o2
  e.addCoupon({ id: 'c2', kind: 'amount', value: 300 });
  e.addCoupon({ id: 'c3', kind: 'amount', value: 100 });
  const first = e.solve();
  // c1 -> o2 (2000 -> 1000), c2 -> o1, c3 -> o1 (1000 -> 600)
  assert.equal(first.total, 1600);
  assert.deepEqual(first.orderAmounts, { o1: 600, o2: 1000 });
  assert.deepEqual(first.ownership['c1'], ['o2']);
  assert.deepEqual(first.ownership['c2'], ['o1']);
  assert.deepEqual(first.ownership['c3'], ['o1']);

  e.settle('o2');
  const after = e.refund(['c2']);
  assert.equal(after.status, 'optimal');
  assert.equal(after.orderAmounts['o2'], 1000); // locked payment unchanged
  assert.equal(after.orderAmounts['o1'], 900); // c2 revoked, c3 reassigned to o1
  assert.deepEqual(after.ownership['c1'], ['o2']);
  assert.deepEqual(after.ownership['c3'], ['o1']);
  assert.equal(after.ownership['c2'], undefined); // revoked coupon is gone
  assert.equal(after.total, 1900);
});

test('refund can force reassignment of remaining coupons across unlocked orders', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 1000);
  e.addOrder('o2', 2000);
  e.addCoupon({ id: 'big', kind: 'amount', value: 1500 });
  e.addCoupon({ id: 'small', kind: 'amount', value: 100 });
  const first = e.solve();
  // big -> o2 (saves 1500), small -> o1 or o2; total = 1000+2000-1500-100 = 1400
  assert.equal(first.total, 1400);
  e.settle('o2');
  const lockedO2 = first.orderAmounts['o2'];
  const after = e.refund(['small']);
  assert.equal(after.orderAmounts['o2'], lockedO2);
  assert.equal(after.status, 'optimal');
});

test('refund of a coupon a locked order depends on is infeasible', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 1000);
  e.addOrder('o2', 1000);
  e.addCoupon({ id: 'c1', kind: 'amount', value: 500 });
  const first = e.solve();
  assert.equal(first.orderAmounts['o1'] + first.orderAmounts['o2'], 1500);
  const lockedOrder = first.ownership['c1'][0];
  e.settle(lockedOrder);
  const after = e.refund(['c1']);
  assert.equal(after.status, 'infeasible');
  assert.equal(after.total, null);
});

test('shared coupon survives across orders and refunds recompute', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 1000);
  e.addOrder('o2', 2000);
  e.addCoupon({ id: 's', kind: 'amount', value: 100, shared: true });
  e.addCoupon({ id: 'x', kind: 'amount', value: 300 });
  const first = e.solve();
  assert.equal(first.total, 1000 + 2000 - 200 - 300);
  assert.deepEqual(first.ownership['s'], ['o1', 'o2']);
  e.settle('o2');
  const after = e.refund(['x']);
  assert.equal(after.orderAmounts['o2'], first.orderAmounts['o2']);
  assert.equal(after.total, 1000 + 2000 - 200);
});

test('library and order limits are enforced', () => {
  const e = new CouponEngine();
  for (let i = 0; i < 18; i++) e.addCoupon({ id: `c${i}`, kind: 'amount', value: 1 });
  assert.throws(() => e.addCoupon({ id: 'c18', kind: 'amount', value: 1 }));
  for (let i = 0; i < 8; i++) e.addOrder(`o${i}`, 100);
  assert.throws(() => e.addOrder('o8', 100));
});

test('invalid coupons are rejected', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 100);
  assert.throws(() => e.addCoupon({ id: 'p', kind: 'percent', value: 101 }));
  assert.throws(() => e.addCoupon({ id: 'a', kind: 'amount', value: -5 }));
  assert.throws(() => e.addCoupon({ id: 's', kind: 'amount', value: 1, prereq: 's' }));
});

test('settle requires a successful solve first', () => {
  const e = new CouponEngine();
  e.addOrder('o1', 100);
  assert.throws(() => e.settle('o1'));
});
