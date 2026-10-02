import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const makeLedger = (limit) => {
  const ledger = new Ledger();
  ledger.addOrder({
    orderId: 'o1', merchantId: 'm1', discount: 0, pointsRate: 0,
    lines: [{ lineId: 'l1', amount: 100000, taxRate: 0.1 }],
  });
  ledger.setBudget('m1', '2026-10', limit);
  return ledger;
};

// Acceptance B: budget boundary — exactly at limit passes, one unit over fails.
test('B: refund up to exactly the budget limit is accepted', () => {
  const ledger = makeLedger(1100); // gross of refunding 1000 @10% tax = 1100
  const node = ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1000 }], { date: '2026-10-05' });
  assert.equal(node.gross, 1100);
  assert.equal(ledger.getBudget('m1', '2026-10').used, 1100);
});

test('B: exceeding the limit is rejected with no partial deduction', () => {
  const ledger = makeLedger(1100);
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1000 }], { date: '2026-10-05' });
  const before = ledger.computeOrder('o1');

  let err;
  try { ledger.refund('r2', 'o1', [{ lineId: 'l1', amount: 1 }], { date: '2026-10-06' }); } catch (e) { err = e; }
  assert.equal(err?.code, 'E_BUDGET_EXCEEDED');
  assert.equal(err.limit, 1100);
  assert.equal(err.used, 1100);

  // all-or-nothing: no partial deduction, no refund recorded, state untouched
  assert.equal(ledger.getBudget('m1', '2026-10').used, 1100);
  assert.equal(ledger.refunds.has('r2'), false);
  assert.deepEqual(ledger.computeOrder('o1'), before);
});

test('B: single refund larger than the whole budget is rejected entirely', () => {
  const ledger = makeLedger(500);
  assert.throws(() => ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1000 }], { date: '2026-10-01' }),
    (e) => e.code === 'E_BUDGET_EXCEEDED');
  assert.equal(ledger.getBudget('m1', '2026-10').used, 0);
  assert.equal(ledger.computeOrder('o1').totals.effective, 100000);
});

test('budget aggregates per merchant and period; revoke frees budget', () => {
  const ledger = makeLedger(1100);
  ledger.refund('r1', 'o1', [{ lineId: 'l1', amount: 1000 }], { date: '2026-10-05' });
  // different period is not blocked
  ledger.addOrder({ orderId: 'o2', merchantId: 'm1', lines: [{ lineId: 'x', amount: 5000, taxRate: 0.1 }] });
  assert.doesNotThrow(() => ledger.refund('r2', 'o2', [{ lineId: 'x', amount: 1000 }], { date: '2026-11-01' }));
  // revoke frees the period budget
  ledger.revoke('r1');
  assert.equal(ledger.getBudget('m1', '2026-10').used, 0);
  assert.doesNotThrow(() => ledger.refund('r3', 'o1', [{ lineId: 'l1', amount: 1000 }], { date: '2026-10-07' }));
});
