import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMultiOrder } from '../src/solver';
import { solveSingleOrder } from '../src/single';
import { bruteForceSolve } from '../src/brute';
import { applyCouponList } from '../src/apply';
import { Coupon, OrderSpec } from '../src/types';

const BIG_BUDGET = 50_000_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand: () => number): { coupons: Coupon[]; orders: OrderSpec[] } {
  const n = 1 + Math.floor(rand() * 9); // 1..9 coupons
  const m = 1 + Math.floor(rand() * 3); // 1..3 orders
  const coupons: Coupon[] = [];
  for (let i = 0; i < n; i++) {
    const c: Coupon = {
      id: `c${i}`,
      kind: rand() < 0.5 ? 'amount' : 'percent',
      value: 0,
    };
    c.value = c.kind === 'amount' ? 10 + Math.floor(rand() * 3000) : 5 + Math.floor(rand() * 86);
    if (i > 0 && rand() < 0.25) c.prereq = `c${Math.floor(rand() * i)}`;
    if (rand() < 0.3) c.mutexGroup = `g${Math.floor(rand() * 2)}`;
    if (rand() < 0.2) c.shared = true;
    coupons.push(c);
  }
  const orders: OrderSpec[] = [];
  for (let j = 0; j < m; j++) {
    orders.push({ id: `o${j}`, amount: 100 + Math.floor(rand() * 20000) });
  }
  return { coupons, orders };
}

test('main solver matches independent brute force on random small instances', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { coupons, orders } = randomInstance(mulberry32(seed));
    const fast = solveMultiOrder(coupons, orders, BIG_BUDGET);
    const slow = bruteForceSolve(coupons, orders);
    assert.equal(fast.status, 'optimal', `seed ${seed}`);
    assert.equal(fast.total, slow.total, `seed ${seed} total`);
    assert.deepEqual(fast.ownership, slow.ownership, `seed ${seed} ownership`);
    assert.deepEqual(fast.orderAmounts, slow.orderAmounts, `seed ${seed} amounts`);
  }
});

test('single-order enumeration matches brute force on random instances', () => {
  for (let seed = 101; seed <= 130; seed++) {
    const { coupons, orders } = randomInstance(mulberry32(seed));
    const one = [orders[0]];
    const s = solveSingleOrder(one[0].amount, coupons);
    const slow = bruteForceSolve(coupons, one);
    assert.equal(s.payment, slow.total, `seed ${seed}`);
  }
});

test('solver with settled orders matches brute force on random instances', () => {
  for (let seed = 201; seed <= 230; seed++) {
    const { coupons, orders } = randomInstance(mulberry32(seed));
    // lock the first order at its optimally solved amount
    const initial = solveMultiOrder(coupons, orders, BIG_BUDGET);
    if (initial.status !== 'optimal') continue;
    const lockedOrders: OrderSpec[] = orders.map((o, j) =>
      j === 0
        ? { ...o, settled: true, lockedAmount: initial.orderAmounts[o.id] }
        : { ...o },
    );
    const fast = solveMultiOrder(coupons, lockedOrders, BIG_BUDGET);
    const slow = bruteForceSolve(coupons, lockedOrders);
    assert.equal(fast.status, slow.status, `seed ${seed} status`);
    assert.equal(fast.total, slow.total, `seed ${seed} total`);
    assert.deepEqual(fast.ownership, slow.ownership, `seed ${seed} ownership`);
    if (fast.status === 'optimal') {
      assert.equal(
        fast.orderAmounts[lockedOrders[0].id],
        lockedOrders[0].lockedAmount,
        `seed ${seed} locked amount preserved`,
      );
    }
  }
});

test('reported ownership always recomputes to the reported amounts', () => {
  for (let seed = 301; seed <= 330; seed++) {
    const { coupons, orders } = randomInstance(mulberry32(seed));
    const r = solveMultiOrder(coupons, orders, BIG_BUDGET);
    if (r.status !== 'optimal') continue;
    for (const o of orders) {
      const list = coupons.filter((c) => (r.ownership[c.id] || []).includes(o.id));
      assert.equal(applyCouponList(o.amount, list), r.orderAmounts[o.id], `seed ${seed} ${o.id}`);
    }
    // non-shared coupons are owned by at most one order
    for (const c of coupons) {
      if (!c.shared) assert.ok(r.ownership[c.id].length <= 1, `seed ${seed} ${c.id}`);
    }
  }
});
