import test from 'node:test';
import assert from 'node:assert/strict';
import { CouponLibrary } from '../src/session.js';
import type { Coupon } from '../src/types.js';

const percent = (id: string, value: number, extra: Partial<Coupon> = {}): Coupon => ({
  id,
  kind: 'percent',
  value,
  ...extra,
});

function buildLibrary(): CouponLibrary {
  const lib = new CouponLibrary();
  lib.addCoupon(percent('S1', 50));
  lib.addCoupon(percent('S2', 50));
  lib.addOrder({ id: 'A', amountCents: 1000 });
  lib.addOrder({ id: 'B', amountCents: 1000 });
  lib.addOrder({ id: 'C', amountCents: 100 });
  return lib;
}

test('共享券分配并输出每券所有权与逐单金额', () => {
  const lib = buildLibrary();
  const report = lib.report();
  assert.equal(report.status, 'optimal');
  assert.deepEqual(report.ownership, { S1: 'A', S2: 'B' });
  assert.deepEqual(report.payments, { A: 500, B: 500, C: 100 });
  assert.equal(report.totalPaymentCents, 1100);
});

test('结算锁定后退款重算:锁定实付不变,未锁订单重新分配', () => {
  const lib = buildLibrary();
  lib.optimize();
  const settled = lib.settle('A');
  assert.equal(settled.paymentCents, 500);
  assert.deepEqual(settled.couponIds, ['S1']);

  const after = lib.refund('B'); // 退 B:S2 回池,未锁订单重算
  assert.equal(after.payments['A'], 500); // 锁定实付不能变化
  assert.equal(after.payments['B'], undefined);
  assert.equal(after.payments['C'], 50); // S2 改配到 C
  assert.equal(after.ownership['S1'], 'A');
  assert.equal(after.ownership['S2'], 'C');
  assert.equal(after.totalPaymentCents, 550);
  assert.equal(lib.verifyPayments(), true);
});

test('退款已结算订单可撤销其券并重新分配', () => {
  const lib = buildLibrary();
  lib.optimize();
  lib.settle('A');
  lib.refund('B');
  const after = lib.refund('A'); // 退已结算的 A:S1 回池
  assert.equal(after.payments['A'], undefined);
  assert.equal(after.payments['C'], 25); // 100 -> 50(S1) -> 25(S2)
  assert.equal(after.ownership['S1'], 'C');
  assert.equal(after.ownership['S2'], 'C');
  assert.equal(after.totalPaymentCents, 25);
  assert.equal(lib.verifyPayments(), true);
});

test('未优化直接结算时自动先优化', () => {
  const lib = new CouponLibrary();
  lib.addCoupon(percent('S', 20));
  lib.addOrder({ id: 'A', amountCents: 500 });
  const settled = lib.settle('A');
  assert.equal(settled.paymentCents, 400);
  assert.deepEqual(settled.couponIds, ['S']);
});

test('退款未知订单报错', () => {
  const lib = buildLibrary();
  assert.throws(() => lib.refund('ZZ'), /不存在/);
});

test('结算未知订单报错', () => {
  const lib = buildLibrary();
  assert.throws(() => lib.settle('ZZ'), /不存在或已结算/);
});

test('会话层规模上限:18 券、8 订单', () => {
  const lib = new CouponLibrary();
  for (let i = 0; i < 18; i++) lib.addCoupon(percent(`P${i}`, 1));
  assert.throws(() => lib.addCoupon(percent('P18', 1)), /至多 18/);
  for (let i = 0; i < 8; i++) lib.addOrder({ id: `O${i}`, amountCents: 10 });
  assert.throws(() => lib.addOrder({ id: 'O8', amountCents: 10 }), /至多 8/);
});
