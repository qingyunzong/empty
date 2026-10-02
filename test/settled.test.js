// Acceptance D: revoking a settled refund fails with E_ALREADY_SETTLED but
// can optionally emit a reverse (counter) refund flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefundLedger } from '../src/ledger.js';

const ORDER = {
  orderId: 'o1',
  merchantId: 'm1',
  discount: 100,
  lines: [{ lineId: 'a', amount: 1000, taxRateBps: 1000, points: 7 }],
};

test('settled revoke errors; with reverse it also emits a reversal record', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  ledger.setBudget('m1', { limit: 5000, period: 'monthly' });
  const r = ledger.refund('r1', ORDER, ['a'], { date: '2026-01-01', settleDays: 1 });
  assert.ok(r.ok);
  assert.equal(r.record.status, 'settled'); // asOf 2026-02-01 >= 2026-01-02
  assert.equal(ledger.usage('m1', '2026-01-01'), r.record.total);

  // Without reverse: plain error, no side effects.
  const plain = ledger.revoke('r1');
  assert.equal(plain.ok, false);
  assert.equal(plain.error.code, 'E_ALREADY_SETTLED');
  assert.equal(plain.reversal, undefined);
  assert.equal(ledger.records.length, 1);

  // With reverse: still an error, but the reverse flow is generated.
  const res = ledger.revoke('r1', { reverse: true });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_ALREADY_SETTLED');
  const rev = res.reversal;
  assert.equal(rev.type, 'reversal');
  assert.equal(rev.parentRefId, 'r1');
  assert.equal(rev.total, -r.record.total);
  assert.equal(rev.tax, -r.record.tax);
  assert.equal(rev.discountReversal, -r.record.discountReversal);
  assert.equal(rev.pointsReversal, -r.record.pointsReversal);
  // reversal releases the budget the original refund consumed
  assert.equal(ledger.usage('m1', '2026-01-01'), 0);

  // A settled refund cannot be reversed twice.
  assert.equal(ledger.revoke('r1', { reverse: true }).error.code, 'E_ALREADY_REVERSED');
});

test('pending refund revokes normally without any reversal', () => {
  const ledger = new RefundLedger({ asOf: '2026-02-01' });
  const r = ledger.refund('r1', ORDER, ['a'], { date: '2026-01-31', settleDays: 7 });
  assert.equal(r.record.status, 'pending');
  const res = ledger.revoke('r1', { reverse: true });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.record.type, 'revoke');
  assert.equal(ledger.records.some((x) => x.type === 'reversal'), false);
});
