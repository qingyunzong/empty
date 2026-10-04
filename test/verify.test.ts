import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeAllocation } from '../src/allocator.js';
import {
  bruteForceAllocate,
  crossCheckAllocation,
} from '../src/verify.js';
import type { Coupon, Order } from '../src/types.js';

/** 确定性伪随机数(LCG),保证测试可复现。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomCase(rng: () => number): { orders: Order[]; coupons: Coupon[] } {
  const orderCount = 1 + Math.floor(rng() * 3);
  const orders: Order[] = Array.from({ length: orderCount }, (_, i) => ({
    id: `O${i}`,
    amountCents: 50 + Math.floor(rng() * 1950),
  }));
  const couponCount = 1 + Math.floor(rng() * 6);
  const coupons: Coupon[] = [];
  for (let i = 0; i < couponCount; i++) {
    const kind = rng() < 0.5 ? 'amount' : 'percent';
    const value =
      kind === 'amount'
        ? 1 + Math.floor(rng() * 300)
        : 5 + 5 * Math.floor(rng() * 18);
    const coupon: { -readonly [K in keyof Coupon]: Coupon[K] } = {
      id: `C${i}`,
      kind,
      value,
    };
    if (i > 0 && rng() < 0.25) {
      coupon.requires = `C${Math.floor(rng() * i)}`; // 仅引用更早的券,保证无环
    }
    if (rng() < 0.3) {
      coupon.mutexGroup = rng() < 0.5 ? 'g0' : 'g1';
    }
    if (rng() < 0.3) {
      const subset = orders.filter(() => rng() < 0.6).map((o) => o.id);
      coupon.orders = subset.length > 0 ? subset : [orders[0].id];
    }
    coupons.push(coupon);
  }
  return { orders, coupons };
}

test('独立小分配枚举核对:60 组随机用例与优化器一致', () => {
  const rng = makeRng(20261005);
  for (let round = 0; round < 60; round++) {
    const { orders, coupons } = randomCase(rng);
    const result = optimizeAllocation(orders, coupons);
    assert.equal(result.status, 'optimal', `第 ${round} 组应已证最优`);
    const check = crossCheckAllocation(orders, coupons, result);
    assert.ok(check.ok, `第 ${round} 组核对失败:\n${check.mismatches.join('\n')}`);
  }
});

test('穷举核对器自身结果符合手算', () => {
  const orders: Order[] = [
    { id: 'A', amountCents: 1000 },
    { id: 'B', amountCents: 200 },
  ];
  const coupons: Coupon[] = [{ id: 'S', kind: 'percent', value: 50 }];
  const brute = bruteForceAllocate(orders, coupons);
  assert.equal(brute.totalPaymentCents, 700);
  assert.equal(brute.ownership['S'], 'A');
  assert.deepEqual(brute.payments, { A: 500, B: 200 });
});

test('穷举核对器拒绝超规模输入', () => {
  const coupons: Coupon[] = Array.from({ length: 13 }, (_, i) => ({
    id: `C${i}`,
    kind: 'amount',
    value: 1,
  }));
  assert.throws(() => bruteForceAllocate([{ id: 'A', amountCents: 10 }], coupons), /穷举核对/);
});

test('非最优状态不参与核对', () => {
  const orders: Order[] = [{ id: 'A', amountCents: 100 }];
  const coupons: Coupon[] = [{ id: 'S', kind: 'percent', value: 10 }];
  const feasible = optimizeAllocation(orders, coupons, [], { maxNodes: 0 });
  assert.equal(feasible.status, 'feasible');
  const check = crossCheckAllocation(orders, coupons, feasible);
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => m.includes('未证明最优')));
});
