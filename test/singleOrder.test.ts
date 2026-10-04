import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCoupon,
  applyCoupons,
  optimizeSingleOrder,
  validateCoupons,
  verifySingleOrderPayment,
} from '../src/singleOrder.js';
import type { Coupon } from '../src/types.js';

const amount = (id: string, value: number, extra: Partial<Coupon> = {}): Coupon => ({
  id,
  kind: 'amount',
  value,
  ...extra,
});
const percent = (id: string, value: number, extra: Partial<Coupon> = {}): Coupon => ({
  id,
  kind: 'percent',
  value,
  ...extra,
});

test('百分比向下取整,整数分计算', () => {
  assert.equal(applyCoupon(199, percent('P', 10)), 180); // 折扣 19,不是 19.9
  assert.equal(applyCoupon(101, percent('P', 50)), 51); // 折扣 50
  assert.equal(applyCoupon(100, percent('P', 100)), 0);
});

test('定额券触底为 0,实付不为负', () => {
  assert.equal(applyCoupon(100, amount('A', 150)), 0);
  assert.equal(applyCoupon(100, amount('A', 100)), 0);
});

test('券按输入序作用,顺序影响结果', () => {
  const off50 = amount('A', 50);
  const pct10 = percent('B', 10);
  assert.equal(applyCoupons(200, [off50, pct10]), 135); // (200-50)*0.9
  assert.equal(applyCoupons(200, [pct10, off50]), 130); // 200*0.9-50
});

test('有向前置:缺前置的子集非法', () => {
  const coupons = [amount('A', 10), amount('B', 900, { requires: 'A' })];
  const best = optimizeSingleOrder(1000, coupons);
  assert.equal(best.paymentCents, 90);
  assert.deepEqual(best.usedCouponIds, ['A', 'B']);
  assert.equal(best.legalSubsets, 3); // {}, {A}, {A,B}
  assert.equal(best.totalSubsets, 4);
});

test('互斥组:同组券不可叠加', () => {
  const coupons = [
    percent('P1', 50, { mutexGroup: 'g' }),
    percent('P2', 40, { mutexGroup: 'g' }),
  ];
  const best = optimizeSingleOrder(200, coupons);
  assert.equal(best.paymentCents, 100);
  assert.deepEqual(best.usedCouponIds, ['P1']);
  assert.equal(best.legalSubsets, 3); // {}, {P1}, {P2}
});

test('平手时选券数少', () => {
  const coupons = [amount('A', 100), amount('B', 60), amount('C', 60)];
  const best = optimizeSingleOrder(100, coupons);
  assert.equal(best.paymentCents, 0);
  assert.deepEqual(best.usedCouponIds, ['A']); // {A} 优于 {B,C}
});

test('平手且券数相同时选 ID 序小', () => {
  // 同组互斥使两券不可叠加,单用各减 50%,实付与券数均平手。
  const coupons = [
    percent('C2', 50, { mutexGroup: 'g' }),
    percent('C1', 50, { mutexGroup: 'g' }),
  ];
  const best = optimizeSingleOrder(100, coupons);
  assert.equal(best.paymentCents, 50);
  assert.deepEqual(best.usedCouponIds, ['C1']);
});

test('枚举全部合法子集验证金额', () => {
  const coupons = [amount('A', 10), amount('B', 900, { requires: 'A' })];
  assert.equal(verifySingleOrderPayment(1000, coupons, 90), true);
  assert.equal(verifySingleOrderPayment(1000, coupons, 91), false);
  assert.equal(verifySingleOrderPayment(1000, coupons, 89), false);
});

test('至多 18 券:18 可枚举,19 拒绝', () => {
  const eighteen = Array.from({ length: 18 }, (_, i) => amount(`K${i}`, i + 1));
  const best = optimizeSingleOrder(1000, eighteen);
  assert.equal(best.paymentCents, 1000 - 171); // 1+2+...+18
  assert.equal(best.usedCouponIds.length, 18);
  assert.equal(best.totalSubsets, 1 << 18);
  const nineteen = [...eighteen, amount('K18', 1)];
  assert.throws(() => optimizeSingleOrder(1000, nineteen), /至多 18/);
});

test('非法券库拒绝:重复 ID、百分比越界、前置缺失、前置成环', () => {
  assert.throws(() => validateCoupons([amount('A', 1), amount('A', 2)]), /重复/);
  assert.throws(() => validateCoupons([percent('P', 101)]), /0\.\.100/);
  assert.throws(() => validateCoupons([amount('A', 1, { requires: 'ZZ' })]), /前置券不存在/);
  assert.throws(
    () =>
      validateCoupons([
        amount('X', 1, { requires: 'Y' }),
        amount('Y', 1, { requires: 'X' }),
      ]),
    /环/,
  );
});
