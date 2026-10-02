import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefundError, RefundService, splitAmount } from '../src/refund.js';

function makeService() {
  const events = [];
  const service = new RefundService({ appendEvent: (e) => events.push(e) });
  return { service, events };
}

test('splitAmount: proportional split with largest remainder', () => {
  assert.deepEqual(splitAmount(100, { merchant: 70, commission: 20, tax: 10 }), {
    merchant: 70,
    commission: 20,
    tax: 10,
  });
  assert.deepEqual(splitAmount(1, { merchant: 1, commission: 1, tax: 1 }), {
    merchant: 1,
    commission: 0,
    tax: 0,
  });
  assert.deepEqual(splitAmount(2, { merchant: 1, commission: 1, tax: 1 }), {
    merchant: 1,
    commission: 1,
    tax: 0,
  });
  const s = splitAmount(10, { merchant: 3, commission: 3, tax: 3 });
  assert.equal(s.merchant + s.commission + s.tax, 10);
});

test('multiple partial refunds accumulate per component and never exceed total', () => {
  const { service } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 70, commission: 20, tax: 10 });

  const r1 = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 33 });
  assert.deepEqual(r1.split, splitAmount(33, { merchant: 70, commission: 20, tax: 10 }));
  service.registerRefund('r1');

  const r2 = service.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 33 });
  service.registerRefund('r2');

  const r3 = service.requestRefund({ refundId: 'r3', paymentId: 'p1', amount: 34 });
  service.registerRefund('r3');

  const balance = service.getBalance('p1');
  assert.deepEqual(balance.posted, { merchant: 70, commission: 20, tax: 10 });
  assert.deepEqual(balance.available, { merchant: 0, commission: 0, tax: 0 });
  assert.deepEqual(balance.frozen, { merchant: 0, commission: 0, tax: 0 });
  assert.equal(balance.refundedTotal, 100);

  // per-step cumulative splits equal the split of the cumulative amount
  const c1 = splitAmount(33, { merchant: 70, commission: 20, tax: 10 });
  const c2 = splitAmount(66, { merchant: 70, commission: 20, tax: 10 });
  assert.deepEqual(r2.split, {
    merchant: c2.merchant - c1.merchant,
    commission: c2.commission - c1.commission,
    tax: c2.tax - c1.tax,
  });
});

test('duplicate refundId returns first result and does not double-post', () => {
  const { service, events } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 50, commission: 30, tax: 20 });

  const first = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  const again = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  assert.deepEqual(again, first);
  // even a conflicting amount returns the first result untouched
  const conflicting = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 10 });
  assert.deepEqual(conflicting, first);
  assert.equal(events.filter((e) => e.type === 'refund_frozen').length, 1);

  service.registerRefund('r1');
  const balance = service.getBalance('p1');
  assert.equal(balance.refundedTotal, 40);
  assert.deepEqual(balance.posted, first.split);
});

test('replay from event history does not double-post', () => {
  const { service, events } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 50, commission: 30, tax: 20 });
  service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  service.registerRefund('r1');
  service.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 25 });
  service.cancelRefund('r2');

  const replayed = RefundService.fromEvents(events);
  assert.deepEqual(replayed.getBalance('p1'), service.getBalance('p1'));
  assert.deepEqual(replayed.getRefund('r1'), service.getRefund('r1'));
  assert.deepEqual(replayed.getRefund('r2'), service.getRefund('r2'));

  // re-requesting an existing refundId on the replayed state is a no-op
  const before = replayed.getBalance('p1');
  const dup = replayed.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  assert.equal(dup.status, 'frozen'); // first result snapshot
  assert.deepEqual(replayed.getBalance('p1'), before);
});

test('over-amount refund returns REFUND_EXCEEDED and leaves state untouched', () => {
  const { service, events } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 60, commission: 25, tax: 15 });
  service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 60 });
  service.registerRefund('r1');
  const before = service.getBalance('p1');
  const eventCount = events.length;

  assert.throws(
    () => service.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 41 }),
    (err) => err instanceof RefundError && err.code === 'REFUND_EXCEEDED',
  );
  assert.deepEqual(service.getBalance('p1'), before);
  assert.equal(events.length, eventCount);
  assert.equal(service.refunds.has('r2'), false);

  // exact remaining amount still succeeds afterwards
  service.requestRefund({ refundId: 'r3', paymentId: 'p1', amount: 40 });
  assert.equal(service.getBalance('p1').refundedTotal + 40 - 40, 60);
  assert.equal(service._effectiveRefunded(service.payments.get('p1')), 100);
});

test('cancel before registration releases the freeze only', () => {
  const { service, events } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 50, commission: 30, tax: 20 });
  const r = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  assert.deepEqual(service.getBalance('p1').frozen, r.split);

  const cancelled = service.cancelRefund('r1');
  assert.equal(cancelled.status, 'released');
  const balance = service.getBalance('p1');
  assert.deepEqual(balance.frozen, { merchant: 0, commission: 0, tax: 0 });
  assert.deepEqual(balance.posted, { merchant: 0, commission: 0, tax: 0 });
  assert.deepEqual(balance.compensated, { merchant: 0, commission: 0, tax: 0 });
  assert.deepEqual(balance.available, { merchant: 50, commission: 30, tax: 20 });
  assert.deepEqual(
    events.map((e) => e.type),
    ['payment_settled', 'refund_frozen', 'refund_released'],
  );
});

test('cancel after registration posts a compensating reversal', () => {
  const { service, events } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 50, commission: 30, tax: 20 });
  const r = service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  service.registerRefund('r1');
  assert.deepEqual(service.getBalance('p1').posted, r.split);

  const cancelled = service.cancelRefund('r1');
  assert.equal(cancelled.status, 'compensated');
  const balance = service.getBalance('p1');
  assert.deepEqual(balance.posted, r.split);
  assert.deepEqual(balance.compensated, r.split);
  assert.deepEqual(balance.available, { merchant: 50, commission: 30, tax: 20 });
  assert.equal(balance.refundedTotal, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ['payment_settled', 'refund_frozen', 'refund_posted', 'refund_compensated'],
  );
});

test('invalid state transitions and unknown ids raise coded errors', () => {
  const { service } = makeService();
  service.settlePayment({ paymentId: 'p1', merchant: 10, commission: 5, tax: 5 });
  assert.throws(() => service.registerRefund('nope'), /refund not found/);
  assert.throws(
    () => service.registerRefund('nope'),
    (err) => err.code === 'REFUND_NOT_FOUND',
  );
  service.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 5 });
  service.cancelRefund('r1');
  assert.throws(
    () => service.cancelRefund('r1'),
    (err) => err.code === 'INVALID_STATE',
  );
  assert.throws(
    () => service.registerRefund('r1'),
    (err) => err.code === 'INVALID_STATE',
  );
  assert.throws(
    () => service.requestRefund({ refundId: 'r2', paymentId: 'ghost', amount: 1 }),
    (err) => err.code === 'PAYMENT_NOT_FOUND',
  );
  assert.throws(
    () => service.requestRefund({ refundId: 'r3', paymentId: 'p1', amount: 0 }),
    (err) => err.code === 'INVALID_AMOUNT',
  );
});
