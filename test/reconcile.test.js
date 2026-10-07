'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TzRegistry,
  normalizeRates,
  postLedger,
  reconcile,
} = require('../index');

function buildLedger() {
  const registry = new TzRegistry();
  registry.load(require('../examples/tz-v1.json'));
  const rates = normalizeRates(require('../examples/rates.json'));
  return postLedger({
    txns: require('../examples/txns.json'),
    registry,
    tzVersion: 'v1',
    policy: 'strict',
    rates,
  });
}

test('reconcile reports amount/day mismatches, missing and unexpected lines', () => {
  const ledger = buildLedger();
  const report = reconcile(ledger, require('../examples/settlement.json'));
  const types = report.diffs.map((d) => `${d.type}:${d.txnId}`).sort();
  assert.deepEqual(types, [
    'AMOUNT_MISMATCH:txn-feb-2',
    'DAY_MISMATCH:txn-mar-1',
    'UNEXPECTED_IN_SETTLEMENT:txn-ghost',
  ]);
  const amount = report.diffs.find((d) => d.type === 'AMOUNT_MISMATCH');
  assert.equal(amount.expectedCents, 36000);
  assert.equal(amount.actualCents, 36100);
  const day = report.diffs.find((d) => d.type === 'DAY_MISMATCH');
  assert.equal(day.expectedDay, '2024-03-05');
  assert.equal(day.actualDay, '2024-03-04');
  assert.equal(report.summary.matched, 2);
  assert.equal(report.rateHits.length, 4);
  assert.equal(report.attestations.length, 4);
});

test('reconcile reports MISSING_IN_SETTLEMENT and NO_RATE', () => {
  const ledger = buildLedger();
  const report = reconcile(ledger, [
    { txnId: 'txn-jan-1', amount: 710.0, localDay: '2024-01-16' },
  ]);
  const missing = report.diffs.filter((d) => d.type === 'MISSING_IN_SETTLEMENT').map((d) => d.txnId);
  assert.deepEqual(missing.sort(), ['txn-feb-1', 'txn-feb-2', 'txn-mar-1']);

  const registry = new TzRegistry();
  registry.load(require('../examples/tz-v1.json'));
  const noRateLedger = postLedger({
    txns: [{ id: 't-x', pair: 'EUR/CNY', amount: 5, utc: '2024-01-10T00:00:00Z' }],
    registry,
    tzVersion: 'v1',
    policy: 'strict',
    rates: normalizeRates(require('../examples/rates.json')),
  });
  const r2 = reconcile(noRateLedger, []);
  assert.equal(r2.diffs[0].type, 'NO_RATE');
});
