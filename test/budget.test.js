// Acceptance B: merchant budget aggregates per period; hitting the limit
// exactly is allowed, exceeding it is rejected with no partial deduction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefundLedger } from '../src/ledger.js';

const mkOrder = (orderId, lines) => ({
  orderId,
  merchantId: 'm1',
  lines: lines.map(([lineId, amount]) => ({ lineId, amount, taxRateBps: 0, points: 0 })),
});

test('budget boundary: equal allowed, one cent over rejected atomically', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  assert.ok(ledger.setBudget('m1', { limit: 1000, period: 'monthly' }).ok);

  const r1 = ledger.refund('r1', mkOrder('o1', [['a', 600]]), ['a'], { date: '2026-01-05' });
  assert.ok(r1.ok, JSON.stringify(r1.error));
  assert.equal(ledger.usage('m1', '2026-01-05'), 600);

  // 600 + 400 = 1000 == limit -> allowed
  const r2 = ledger.refund('r2', mkOrder('o2', [['a', 400]]), ['a'], { date: '2026-01-06' });
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.equal(ledger.usage('m1', '2026-01-06'), 1000);

  // 1000 + 1 > 1000 -> rejected, nothing deducted
  const r3 = ledger.refund('r3', mkOrder('o3', [['a', 1]]), ['a'], { date: '2026-01-07' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'E_BUDGET_EXCEEDED');
  assert.equal(ledger.usage('m1', '2026-01-07'), 1000);
  assert.equal(ledger.refunds.has('r3'), false);
  assert.equal(ledger.records.filter((r) => r.type === 'refund').length, 2);
});

test('no partial deduction when a single refund exceeds the limit', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  ledger.setBudget('m1', { limit: 500, period: 'monthly' });
  const res = ledger.refund('big', mkOrder('o1', [['a', 400], ['b', 200]]), ['a', 'b'], {
    date: '2026-01-05',
  });
  assert.equal(res.error.code, 'E_BUDGET_EXCEEDED');
  assert.equal(ledger.usage('m1', '2026-01-05'), 0);
  // lines were not consumed either
  assert.equal(ledger.orderState('o1').refundedLines.size, 0);
});

test('revoke releases budget; reversal of a settled refund releases it too', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  ledger.setBudget('m1', { limit: 1000, period: 'monthly' });
  ledger.refund('r1', mkOrder('o1', [['a', 700]]), ['a'], { date: '2026-01-05', settleDays: 90 });
  ledger.refund('r2', mkOrder('o2', [['a', 300]]), ['a'], { date: '2026-01-06', settleDays: 90 });
  assert.equal(ledger.usage('m1', '2026-01-06'), 1000);

  assert.ok(ledger.revoke('r2').ok);
  assert.equal(ledger.usage('m1', '2026-01-06'), 700);
  const r3 = ledger.refund('r3', mkOrder('o3', [['a', 300]]), ['a'], { date: '2026-01-07' });
  assert.ok(r3.ok, JSON.stringify(r3.error));
});

test('budget periods aggregate independently', () => {
  const ledger = new RefundLedger({ asOf: '2026-03-01' });
  ledger.setBudget('m1', { limit: 100, period: 'monthly' });
  assert.ok(ledger.refund('jan', mkOrder('o1', [['a', 100]]), ['a'], { date: '2026-01-31' }).ok);
  // same merchant, different month -> fresh budget
  assert.ok(ledger.refund('feb', mkOrder('o2', [['a', 100]]), ['a'], { date: '2026-02-01' }).ok);
  const over = ledger.refund('feb2', mkOrder('o3', [['a', 1]]), ['a'], { date: '2026-02-02' });
  assert.equal(over.error.code, 'E_BUDGET_EXCEEDED');
});
