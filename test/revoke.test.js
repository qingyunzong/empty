// Acceptance A: two-level revoke restores the original discount; a failed
// child leaves the whole subtree untouched with E_ROLLBACK_PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefundLedger } from '../src/ledger.js';

const ORDER = {
  orderId: 'o1',
  merchantId: 'm1',
  discount: 300,
  lines: [
    { lineId: 'a', amount: 1000, taxRateBps: 1000, points: 10 },
    { lineId: 'b', amount: 2000, taxRateBps: 1000, points: 20 },
    { lineId: 'c', amount: 3000, taxRateBps: 1000, points: 30 },
  ],
};
// discount shares: a=50, b=100, c=150 (exact proportional split)

test('two-level revoke cascades and restores original discount, tax and points', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  const r1 = ledger.refund('r1', ORDER, ['a'], { date: '2026-01-10', settleDays: 90 });
  const r2 = ledger.refund('r2', ORDER, ['b'], { date: '2026-01-11', settleDays: 90 });
  assert.ok(r1.ok && r2.ok);

  const st = ledger.orderState('o1');
  assert.equal(st.consumedDiscount, 150); // 50 + 100
  assert.equal(st.clawedPoints, 30); // 10 + 20
  assert.equal(r1.record.discountReversal, 50);
  assert.equal(r2.record.discountReversal, 100);
  // tax on discounted net: a -> (1000-50)*10% = 95, b -> (2000-100)*10% = 190
  assert.equal(r1.record.tax, 95);
  assert.equal(r2.record.tax, 190);

  // Revoking the parent must roll back the child first, then itself.
  const res = ledger.revoke('r1');
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.deepEqual(res.record.rolledBack, ['r2', 'r1']);
  assert.equal(res.record.restoredDiscount, 150);
  assert.equal(res.record.restoredPoints, 30);

  // Original discount/points fully restored; lines refundable again.
  assert.equal(st.consumedDiscount, 0);
  assert.equal(st.clawedPoints, 0);
  assert.equal(st.refundedLines.size, 0);
  const again = ledger.refund('r3', ORDER, ['a', 'b'], { date: '2026-01-12', settleDays: 90 });
  assert.ok(again.ok, JSON.stringify(again.error));
  assert.equal(again.record.discountReversal, 150);
});

test('settled child blocks parent revoke: E_ROLLBACK_PATH, subtree untouched', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  ledger.refund('r1', ORDER, ['a'], { date: '2026-01-10', settleDays: 90 }); // pending
  ledger.refund('r2', ORDER, ['b'], { date: '2026-01-11', settleDays: 1 }); // settled 01-12

  const st = ledger.orderState('o1');
  const before = {
    consumedDiscount: st.consumedDiscount,
    clawedPoints: st.clawedPoints,
    lines: new Set(st.refundedLines),
    records: ledger.records.length,
  };

  const res = ledger.revoke('r1');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_ROLLBACK_PATH');
  assert.deepEqual(res.error.path, ['r1', 'r2']);

  // Nothing changed: no partial rollback of the subtree.
  assert.equal(st.consumedDiscount, before.consumedDiscount);
  assert.equal(st.clawedPoints, before.clawedPoints);
  assert.deepEqual(st.refundedLines, before.lines);
  assert.equal(ledger.records.length, before.records);
  assert.equal(ledger.refunds.get('r1').status, 'active');
  assert.equal(ledger.refunds.get('r2').status, 'active');
});

test('revoke of unknown / already-revoked refunds', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  assert.equal(ledger.revoke('nope').error.code, 'E_NOT_FOUND');
  ledger.refund('r1', ORDER, ['a'], { date: '2026-01-10', settleDays: 90 });
  assert.ok(ledger.revoke('r1').ok);
  assert.equal(ledger.revoke('r1').error.code, 'E_ALREADY_REVOKED');
});
