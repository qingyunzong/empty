import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon, applyCouponList } from '../src/apply';
import { solveSingleOrder } from '../src/single';
import { Coupon } from '../src/types';

test('amount coupon subtracts cents and clamps at zero', () => {
  const c: Coupon = { id: 'a', kind: 'amount', value: 500 };
  assert.equal(applyCoupon(1000, c), 500);
  assert.equal(applyCoupon(300, c), 0);
});

test('percent coupon rounds the discount down', () => {
  const c: Coupon = { id: 'p', kind: 'percent', value: 10 };
  // 10% of 105 = 10.5 -> discount 10 -> pay 95
  assert.equal(applyCoupon(105, c), 95);
  assert.equal(applyCoupon(99, c), 90); // floor(9.9) = 9
  assert.equal(applyCoupon(100, c), 90);
});

test('coupons apply in input order, not in a reordered sequence', () => {
  const pct: Coupon = { id: 'p', kind: 'percent', value: 10 };
  const amt: Coupon = { id: 'a', kind: 'amount', value: 500 };
  assert.equal(applyCouponList(10000, [pct, amt]), 8500); // 9000 - 500
  assert.equal(applyCouponList(10000, [amt, pct]), 8550); // 9500 - 950
});

test('prereq forces the prerequisite coupon into the subset', () => {
  const coupons: Coupon[] = [
    { id: 'A', kind: 'amount', value: 1 },
    { id: 'B', kind: 'amount', value: 5000, prereq: 'A' },
  ];
  const s = solveSingleOrder(10000, coupons);
  assert.equal(s.payment, 4999);
  assert.deepEqual(s.couponIds, ['A', 'B']);
});

test('mutex group coupons cannot combine on one order', () => {
  const coupons: Coupon[] = [
    { id: 'A', kind: 'amount', value: 300, mutexGroup: 'g' },
    { id: 'B', kind: 'amount', value: 500, mutexGroup: 'g' },
  ];
  const s = solveSingleOrder(1000, coupons);
  assert.equal(s.payment, 500);
  assert.deepEqual(s.couponIds, ['B']);
});

test('tie on payment breaks to fewer coupons', () => {
  // every subset pays 0; the winner is the smallest one
  const coupons: Coupon[] = [
    { id: 'A', kind: 'amount', value: 500 },
    { id: 'B', kind: 'amount', value: 300 },
    { id: 'C', kind: 'amount', value: 200 },
  ];
  const s = solveSingleOrder(500, coupons);
  assert.equal(s.payment, 0);
  assert.deepEqual(s.couponIds, ['A']);
});

test('tie on payment and count breaks to smaller id list regardless of input order', () => {
  const coupons: Coupon[] = [
    { id: 'B', kind: 'amount', value: 500 },
    { id: 'A', kind: 'amount', value: 500 },
  ];
  const s = solveSingleOrder(500, coupons);
  assert.equal(s.payment, 0);
  assert.deepEqual(s.couponIds, ['A']);
});

test('enumerates all 2^n subsets', () => {
  const coupons: Coupon[] = [
    { id: 'a', kind: 'amount', value: 1 },
    { id: 'b', kind: 'amount', value: 2 },
    { id: 'c', kind: 'amount', value: 3 },
  ];
  const s = solveSingleOrder(100, coupons);
  assert.equal(s.subsetsEvaluated, 8);
  assert.equal(s.legalSubsets, 8);
});

test('dangling prereq makes a coupon unusable', () => {
  const coupons: Coupon[] = [{ id: 'B', kind: 'amount', value: 500, prereq: 'MISSING' }];
  const s = solveSingleOrder(1000, coupons);
  assert.equal(s.payment, 1000);
  assert.deepEqual(s.couponIds, []);
});
