import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeAllocation } from '../src/allocator.js';
import type { Coupon, Order } from '../src/types.js';

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
const order = (id: string, amountCents: number): Order => ({ id, amountCents });

test('跨订单共享券分给出最高抵扣的订单', () => {
  const result = optimizeAllocation(
    [order('A', 1000), order('B', 200)],
    [percent('S', 50)],
  );
  assert.equal(result.status, 'optimal');
  assert.equal(result.ownership['S'], 'A');
  assert.deepEqual(result.payments, { A: 500, B: 200 });
  assert.equal(result.totalPaymentCents, 700);
});

test('限定订单的券只能落在指定订单', () => {
  const result = optimizeAllocation(
    [order('A', 1000), order('B', 200)],
    [percent('S', 50, { orders: ['B'] })],
  );
  assert.equal(result.ownership['S'], 'B');
  assert.deepEqual(result.payments, { A: 1000, B: 100 });
});

test('零收益券保持闲置(券数少优先)', () => {
  const result = optimizeAllocation([order('A', 1000)], [percent('Z', 0)]);
  assert.equal(result.ownership['Z'], null);
  assert.equal(result.usedCouponCount, 0);
  assert.equal(result.payments['A'], 1000);
});

test('平手时所有权向量取订单 ID 序小', () => {
  const result = optimizeAllocation(
    [order('X', 1000), order('Y', 1000)],
    [percent('S', 50)],
  );
  assert.equal(result.ownership['S'], 'X');
});

test('互斥组按订单隔离:同组券可拆到不同订单', () => {
  const result = optimizeAllocation(
    [order('A', 1000), order('B', 1000)],
    [percent('M1', 50, { mutexGroup: 'g' }), percent('M2', 40, { mutexGroup: 'g' })],
  );
  assert.equal(result.status, 'optimal');
  assert.equal(result.totalPaymentCents, 1100); // 500 + 600
  assert.equal(result.ownership['M1'], 'A');
  assert.equal(result.ownership['M2'], 'B');
  assert.equal(result.usedCouponCount, 2);
});

test('有向前置:前置券与被引券必须同单', () => {
  const result = optimizeAllocation(
    [order('X', 1000), order('Y', 1000)],
    [amount('A1', 1), amount('B1', 500, { requires: 'A1' })],
  );
  assert.equal(result.status, 'optimal');
  assert.equal(result.ownership['A1'], result.ownership['B1']);
  assert.equal(result.totalPaymentCents, 1499); // (1000-1-500) + 1000
});

test('锁定订单:实付冻结且用券不参与再分配', () => {
  const locked = [
    { order: order('A', 1000), paymentCents: 500, coupons: [percent('S', 50)] },
  ];
  const result = optimizeAllocation(
    [order('B', 1000)],
    [amount('T', 100)],
    locked,
  );
  assert.equal(result.status, 'optimal');
  assert.equal(result.payments['A'], 500); // 锁定实付不能变化
  assert.equal(result.payments['B'], 900);
  assert.equal(result.ownership['S'], 'A');
  assert.equal(result.ownership['T'], 'B');
  assert.equal(result.totalPaymentCents, 1400);
});

test('锁定单实付与用券不符时拒绝', () => {
  const locked = [
    { order: order('A', 1000), paymentCents: 400, coupons: [percent('S', 50)] },
  ];
  assert.throws(() => optimizeAllocation([order('B', 100)], [], locked), /不符/);
});

test('搜索预算:预算耗尽为可行,穷尽空间为已证最优', () => {
  const coupons = Array.from({ length: 6 }, (_, i) => percent(`P${i}`, 10));
  const orders = [order('A', 500), order('B', 500), order('C', 500)];
  const limited = optimizeAllocation(orders, coupons, [], { maxNodes: 1 });
  assert.equal(limited.status, 'feasible');
  const proven = optimizeAllocation(orders, coupons);
  assert.equal(proven.status, 'optimal');
  assert.ok(limited.totalPaymentCents >= proven.totalPaymentCents);
});

test('零预算立即返回可行解(贪心兜底)', () => {
  const coupons = Array.from({ length: 18 }, (_, i) => percent(`P${i}`, 5));
  const orders = Array.from({ length: 8 }, (_, i) => order(`O${i}`, 1000));
  const result = optimizeAllocation(orders, coupons, [], { maxNodes: 0 });
  assert.equal(result.status, 'feasible');
  assert.ok(result.totalPaymentCents < 8000); // 贪心已用券
});

test('18 券单订单可证最优', () => {
  const coupons = Array.from({ length: 18 }, (_, i) => amount(`K${i}`, 1));
  const result = optimizeAllocation([order('A', 18)], coupons);
  assert.equal(result.status, 'optimal');
  assert.equal(result.totalPaymentCents, 0);
  assert.equal(result.usedCouponCount, 18);
});

test('规模上限:至多 18 券、8 订单', () => {
  const coupons19 = Array.from({ length: 19 }, (_, i) => amount(`K${i}`, 1));
  assert.throws(() => optimizeAllocation([order('A', 1)], coupons19), /至多 18/);
  const orders9 = Array.from({ length: 9 }, (_, i) => order(`O${i}`, 1));
  assert.throws(() => optimizeAllocation(orders9, []), /至多 8/);
});

test('券引用未知订单时拒绝', () => {
  assert.throws(
    () => optimizeAllocation([order('A', 100)], [percent('S', 10, { orders: ['ZZ'] })]),
    /未知订单/,
  );
});
