import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMultiOrder } from '../src/solver';
import { applyCouponList } from '../src/apply';
import { Coupon, OrderSpec } from '../src/types';

const BIG_BUDGET = 50_000_000;

function ordersOf(...amounts: number[]): OrderSpec[] {
  return amounts.map((amount, i) => ({ id: `o${i + 1}`, amount }));
}

function recompute(coupons: Coupon[], orders: OrderSpec[], ownership: Record<string, string[]>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const o of orders) {
    const list = coupons.filter((c) => (ownership[c.id] || []).includes(o.id));
    result[o.id] = applyCouponList(o.amount, list);
  }
  return result;
}

test('percent coupon goes to the order where it saves most', () => {
  const coupons: Coupon[] = [{ id: 'p50', kind: 'percent', value: 50 }];
  const r = solveMultiOrder(coupons, ordersOf(10000, 20000), BIG_BUDGET);
  assert.equal(r.status, 'optimal');
  assert.equal(r.total, 20000);
  assert.deepEqual(r.ownership['p50'], ['o2']);
  assert.deepEqual(r.orderAmounts, { o1: 10000, o2: 10000 });
});

test('shared coupon applies to several orders at once', () => {
  const coupons: Coupon[] = [{ id: 's', kind: 'amount', value: 100, shared: true }];
  const r = solveMultiOrder(coupons, ordersOf(1000, 2000), BIG_BUDGET);
  assert.equal(r.total, 2800);
  assert.deepEqual(r.ownership['s'], ['o1', 'o2']);
  assert.deepEqual(r.orderAmounts, { o1: 900, o2: 1900 });
});

test('non-shared coupon is owned by at most one order', () => {
  const coupons: Coupon[] = [{ id: 'a', kind: 'amount', value: 100 }];
  const r = solveMultiOrder(coupons, ordersOf(1000, 2000), BIG_BUDGET);
  assert.equal(r.ownership['a'].length, 1);
  assert.equal(r.total, 2900);
});

test('prereq is enforced per order across orders', () => {
  const coupons: Coupon[] = [
    { id: 'A', kind: 'amount', value: 1 },
    { id: 'B', kind: 'amount', value: 10000, prereq: 'A' },
  ];
  const r = solveMultiOrder(coupons, ordersOf(100, 20000), BIG_BUDGET);
  assert.equal(r.total, 10099);
  assert.deepEqual(r.ownership['A'], ['o2']);
  assert.deepEqual(r.ownership['B'], ['o2']);
});

test('mutex group is per order: two orders may each take one coupon of the group', () => {
  const coupons: Coupon[] = [
    { id: 'A', kind: 'amount', value: 500, mutexGroup: 'g' },
    { id: 'B', kind: 'amount', value: 500, mutexGroup: 'g' },
  ];
  const r = solveMultiOrder(coupons, ordersOf(1000, 1000), BIG_BUDGET);
  assert.equal(r.total, 1000);
  const owners = [r.ownership['A'][0], r.ownership['B'][0]].sort();
  assert.deepEqual(owners, ['o1', 'o2']);
});

test('settled order keeps its locked amount', () => {
  const coupons: Coupon[] = [{ id: 'c', kind: 'amount', value: 500 }];
  const orders: OrderSpec[] = [
    { id: 'o1', amount: 1000, settled: true, lockedAmount: 1000 },
    { id: 'o2', amount: 1000 },
  ];
  const r = solveMultiOrder(coupons, orders, BIG_BUDGET);
  assert.equal(r.status, 'optimal');
  assert.equal(r.orderAmounts['o1'], 1000); // locked at full price
  assert.deepEqual(r.ownership['c'], ['o2']); // coupon must not touch o1
  assert.equal(r.total, 1500);
});

test('locked amount is reproduced exactly when a coupon must stay on the settled order', () => {
  const coupons: Coupon[] = [{ id: 'c', kind: 'amount', value: 500 }];
  const orders: OrderSpec[] = [
    { id: 'o1', amount: 1000, settled: true, lockedAmount: 500 },
    { id: 'o2', amount: 1000 },
  ];
  const r = solveMultiOrder(coupons, orders, BIG_BUDGET);
  assert.equal(r.status, 'optimal');
  assert.equal(r.orderAmounts['o1'], 500);
  assert.deepEqual(r.ownership['c'], ['o1']); // the only way to keep the lock
  assert.equal(r.total, 1500);
});

test('infeasible when a locked amount cannot be reproduced', () => {
  const coupons: Coupon[] = [{ id: 'c', kind: 'amount', value: 500 }];
  const orders: OrderSpec[] = [
    { id: 'o1', amount: 1000, settled: true, lockedAmount: 300 },
    { id: 'o2', amount: 1000 },
  ];
  const r = solveMultiOrder(coupons, orders, BIG_BUDGET);
  assert.equal(r.status, 'infeasible');
  assert.equal(r.total, null);
});

test('tiny budget yields a feasible but unproven result', () => {
  const coupons: Coupon[] = [];
  for (let i = 0; i < 18; i++) {
    coupons.push({ id: `c${i}`, kind: 'amount', value: 10 + i });
  }
  const orders = ordersOf(5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000);
  const r = solveMultiOrder(coupons, orders, 100);
  assert.equal(r.status, 'feasible');
  assert.equal(r.provenOptimal, false);
  assert.equal(r.budgetExhausted, true);
  assert.ok(r.total !== null);
  // reported amounts must be consistent with the reported ownership
  assert.deepEqual(recompute(coupons, orders, r.ownership), r.orderAmounts);
});

test('large budget on a small instance proves optimality', () => {
  const coupons: Coupon[] = [
    { id: 'a', kind: 'amount', value: 100 },
    { id: 'b', kind: 'percent', value: 10 },
  ];
  const r = solveMultiOrder(coupons, ordersOf(1000, 2000), BIG_BUDGET);
  assert.equal(r.status, 'optimal');
  assert.equal(r.provenOptimal, true);
});

test('rejects more than 18 coupons or 8 orders', () => {
  const many: Coupon[] = [];
  for (let i = 0; i < 19; i++) many.push({ id: `c${i}`, kind: 'amount', value: 1 });
  assert.throws(() => solveMultiOrder(many, ordersOf(100), 10));
  const nineOrders = ordersOf(1, 2, 3, 4, 5, 6, 7, 8, 9);
  assert.throws(() => solveMultiOrder([], nineOrders, 10));
});
