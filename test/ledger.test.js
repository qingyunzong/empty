import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, RefundError } from '../src/ledger.js';

const KEYS = ['merchant', 'commission', 'tax'];

function sumSplit(a, b) {
  const out = {};
  for (const key of KEYS) out[key] = a[key] + b[key];
  return out;
}

function makeLedger() {
  const ledger = new Ledger();
  ledger.addPayment({ paymentId: 'p1', merchant: 70, commission: 20, tax: 10 });
  return ledger;
}

test('multiple partial refunds accumulate correct component splits within total', () => {
  const ledger = makeLedger();
  const amounts = [33, 33, 34];
  let cumulative = { merchant: 0, commission: 0, tax: 0 };
  let total = 0;
  amounts.forEach((amount, i) => {
    const { result, event } = ledger.requestRefund({ refundId: `r${i}`, paymentId: 'p1', amount });
    assert.ok(event, 'each new refund appends a freeze event');
    assert.equal(result.status, 'FROZEN');
    const splitSum = KEYS.reduce((s, k) => s + result.split[k], 0);
    assert.equal(splitSum, amount, 'split sums to the refund amount');
    cumulative = sumSplit(cumulative, result.split);
    total += amount;
    ledger.registerRefund({ refundId: `r${i}` });
  });
  assert.equal(total, 100);
  const snap = ledger.snapshot();
  assert.equal(snap.payments.length, 1);
  assert.deepEqual(snap.payments[0].posted, cumulative);
  assert.equal(snap.payments[0].postedTotal, 100);
  assert.equal(snap.payments[0].remaining, 0);
  assert.ok(snap.payments[0].postedTotal <= snap.payments[0].total);
});

test('duplicate refundId returns first result and never double-posts', () => {
  const ledger = makeLedger();
  const first = ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  const eventCount = ledger.events.length;

  const again = ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 40 });
  assert.deepEqual(again.result, first.result);
  assert.equal(again.event, null);

  const different = ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 5 });
  assert.deepEqual(different.result, first.result, 'even a different payload returns the first result');
  assert.equal(ledger.events.length, eventCount, 'no extra events appended');

  ledger.registerRefund({ refundId: 'r1' });
  const afterRegister = ledger.events.length;
  const dupRegister = ledger.registerRefund({ refundId: 'r1' });
  assert.equal(dupRegister.event, null);
  assert.equal(ledger.events.length, afterRegister, 're-registering does not post twice');

  const postEvents = ledger.events.filter((e) => e.type === 'post' && e.refundId === 'r1');
  assert.equal(postEvents.length, 1, 'exactly one set of reverse entries');
});

test('replay of the event history reproduces identical state without duplicate postings', () => {
  const ledger = makeLedger();
  ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 25 });
  ledger.registerRefund({ refundId: 'r1' });
  ledger.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 10 });
  ledger.cancelRefund({ refundId: 'r2' });

  const replayed = Ledger.replay(ledger.events);
  assert.deepEqual(replayed.snapshot(), ledger.snapshot());
  assert.deepEqual(replayed.events, ledger.events);

  const replayedAgain = Ledger.replay(ledger.events);
  assert.deepEqual(replayedAgain.snapshot(), ledger.snapshot());
});

test('over-limit refund returns REFUND_EXCEEDED and leaves the ledger untouched', () => {
  const ledger = makeLedger();
  ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 90 });
  ledger.registerRefund({ refundId: 'r1' });
  const before = ledger.snapshot();
  const eventCount = ledger.events.length;

  assert.throws(
    () => ledger.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 11 }),
    (err) => err instanceof RefundError && err.code === 'REFUND_EXCEEDED',
  );
  assert.equal(ledger.events.length, eventCount, 'no event appended on failure');
  assert.deepEqual(ledger.snapshot(), before, 'state unchanged');

  assert.equal(ledger.requestRefund({ refundId: 'r3', paymentId: 'p1', amount: 10 }).result.status, 'FROZEN');
});

test('cancel before registration only releases the freeze', () => {
  const ledger = makeLedger();
  ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 30 });
  const { result, event } = ledger.cancelRefund({ refundId: 'r1' });
  assert.equal(result.status, 'RELEASED');
  assert.equal(event.type, 'release');
  assert.deepEqual(event.released, { merchant: 21, commission: 6, tax: 3 });

  const types = ledger.events.map((e) => e.type);
  assert.deepEqual(types, ['payment', 'freeze', 'release']);
  assert.equal(ledger.snapshot().payments[0].remaining, 100, 'released amount is refundable again');

  const reuse = ledger.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 100 });
  assert.equal(reuse.result.status, 'FROZEN');
});

test('cancel after registration posts compensating entries that reverse the refund', () => {
  const ledger = makeLedger();
  ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 30 });
  const registered = ledger.registerRefund({ refundId: 'r1' });
  const cancelled = ledger.cancelRefund({ refundId: 'r1' });

  assert.equal(cancelled.result.status, 'COMPENSATED');
  assert.equal(cancelled.event.type, 'compensate');

  const postEntries = registered.event.entries;
  const compEntries = cancelled.event.entries;
  assert.equal(compEntries.length, postEntries.length);
  for (let i = 0; i < postEntries.length; i += 1) {
    assert.equal(compEntries[i].account, postEntries[i].account);
    assert.equal(compEntries[i].amount, postEntries[i].amount);
    assert.notEqual(compEntries[i].direction, postEntries[i].direction);
  }

  const net = { merchant: 0, commission: 0, tax: 0 };
  for (const entry of [...postEntries, ...compEntries]) {
    net[entry.account] += entry.direction === 'debit' ? entry.amount : -entry.amount;
  }
  assert.deepEqual(net, { merchant: 0, commission: 0, tax: 0 }, 'net ledger effect is zero');

  const snap = ledger.snapshot();
  assert.equal(snap.payments[0].postedTotal, 0);
  assert.equal(snap.payments[0].frozenTotal, 0);
});

test('invalid state transitions and unknown ids raise coded errors', () => {
  const ledger = makeLedger();
  assert.throws(
    () => ledger.registerRefund({ refundId: 'nope' }),
    (err) => err.code === 'REFUND_NOT_FOUND',
  );
  assert.throws(
    () => ledger.cancelRefund({ refundId: 'nope' }),
    (err) => err.code === 'REFUND_NOT_FOUND',
  );
  assert.throws(
    () => ledger.requestRefund({ refundId: 'r1', paymentId: 'ghost', amount: 1 }),
    (err) => err.code === 'PAYMENT_NOT_FOUND',
  );

  ledger.requestRefund({ refundId: 'r1', paymentId: 'p1', amount: 10 });
  ledger.cancelRefund({ refundId: 'r1' });
  assert.throws(
    () => ledger.registerRefund({ refundId: 'r1' }),
    (err) => err.code === 'INVALID_STATE',
  );

  assert.throws(
    () => ledger.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 0 }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => ledger.requestRefund({ refundId: 'r2', paymentId: 'p1', amount: 1.5 }),
    (err) => err.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => ledger.addPayment({ paymentId: 'p1', merchant: 1, commission: 1, tax: 1 }),
    (err) => err.code === 'PAYMENT_EXISTS',
  );
});
