'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TzRegistry,
  normalizeRates,
  postLedger,
  applyCorrection,
  CODES,
} = require('../index');

function setup() {
  const registry = new TzRegistry();
  registry.load(require('../examples/tz-v1.json'));
  registry.load(require('../examples/tz-v2.json'));
  const rates = normalizeRates(require('../examples/rates.json'));
  const txns = require('../examples/txns.json');
  const ledger = postLedger({ txns, registry, tzVersion: 'v1', policy: 'strict', rates });
  return { registry, rates, ledger };
}

const byId = (l, id) => l.postings.find((p) => p.txnId === id);

test('posting pins tzVersion and policy into every attestation', () => {
  const { ledger } = setup();
  assert.equal(ledger.postings.length, 4);
  for (const p of ledger.postings) {
    assert.equal(p.attestation.tzVersion, 'v1');
    assert.equal(p.attestation.policy, 'strict');
    assert.equal(p.attestation.resolution, 'unique');
  }
  const jan = byId(ledger, 'txn-jan-1');
  assert.equal(jan.attestation.localDay, '2024-01-16');
  assert.equal(jan.rateHit.intervalId, 'USD/CNY-2024-01');
  assert.equal(jan.expected.amountCents, 71000);
});

test('acceptance 3: a correction recomputes only intersecting rate intervals', () => {
  const { registry, rates, ledger } = setup();
  const correction = { id: 'corr-1', txnId: 'txn-feb-1', newUtc: '2024-02-12T09:00:00Z', newAmount: 210.0 };
  const next = applyCorrection(ledger, correction, { registry, rates });

  // Window stays inside February: only the Feb interval is affected.
  assert.deepEqual(next.lastImpact.rateIntervals, ['USD/CNY-2024-02']);
  const impacted = [...next.lastImpact.postings].sort();
  assert.deepEqual(impacted, ['txn-feb-1', 'txn-feb-2']);

  // January and March postings are untouched (same object references).
  assert.equal(byId(next, 'txn-jan-1'), byId(ledger, 'txn-jan-1'));
  assert.equal(byId(next, 'txn-mar-1'), byId(ledger, 'txn-mar-1'));

  // Corrected txn reflects new amount and time; recomputed under pinned v1.
  const fixed = byId(next, 'txn-feb-1');
  assert.equal(fixed.amountCents, 21000);
  assert.equal(fixed.expected.amountCents, Math.round(21000 * 7.2));
  assert.equal(fixed.attestation.tzVersion, 'v1');
  assert.equal(fixed.attestation.correctedBy, 'corr-1');
});

test('correction crossing a rate boundary widens the impact set to both intervals', () => {
  const { registry, rates, ledger } = setup();
  const correction = { id: 'corr-x', txnId: 'txn-feb-1', newUtc: '2024-03-02T00:00:00Z' };
  const next = applyCorrection(ledger, correction, { registry, rates });
  assert.deepEqual(
    [...next.lastImpact.rateIntervals].sort(),
    ['USD/CNY-2024-02', 'USD/CNY-2024-03']
  );
  assert.ok(next.lastImpact.postings.includes('txn-mar-1'));
});

test('E_REPLAY: duplicate correction id is rejected', () => {
  const { registry, rates, ledger } = setup();
  const correction = { id: 'corr-1', txnId: 'txn-feb-1', newAmount: 1 };
  const next = applyCorrection(ledger, correction, { registry, rates });
  assert.throws(
    () => applyCorrection(next, correction, { registry, rates }),
    (err) => err.code === CODES.REPLAY
  );
});

test('E_REPLAY: recompute must use the pinned tz version, not the current table', () => {
  const { registry, rates, ledger } = setup();
  assert.equal(registry.currentVersion, 'v2'); // hot-updated after posting
  const correction = { id: 'corr-2', txnId: 'txn-jan-1', newAmount: 100, tzVersion: 'v2' };
  assert.throws(
    () => applyCorrection(ledger, correction, { registry, rates }),
    (err) => err.code === CODES.REPLAY
  );
  // Explicit migration is possible but must be opted into.
  const migrated = applyCorrection(ledger, correction, { registry, rates, allowRepin: true });
  assert.ok(migrated.appliedCorrections.includes('corr-2'));
});

test('hot-updated current table never changes historical postings', () => {
  const { registry, rates, ledger } = setup();
  const correction = { id: 'corr-3', txnId: 'txn-jan-1', newAmount: 123.45 };
  const next = applyCorrection(ledger, correction, { registry, rates });
  const jan = byId(next, 'txn-jan-1');
  assert.equal(jan.attestation.tzVersion, 'v1'); // still pinned
  assert.equal(jan.attestation.localDay, '2024-01-16'); // v1 (+08:00) result, not v2
});

test('local-time correction records policy resolution in attestation', () => {
  const registry = new TzRegistry();
  registry.load({
    version: 'fold',
    segments: [
      { utcStart: '2024-01-01T00:00:00Z', utcEnd: '2024-10-27T01:00:00Z', offsetSeconds: 7200 },
      { utcStart: '2024-10-27T01:00:00Z', utcEnd: '2025-01-01T00:00:00Z', offsetSeconds: 3600 },
    ],
  });
  const rates = normalizeRates([
    { id: 'r1', pair: 'USD/CNY', rate: 7.0, version: 'fx', startUtc: '2024-01-01T00:00:00Z', endUtc: '2025-01-01T00:00:00Z' },
  ]);
  const ledger = postLedger({
    txns: [{ id: 't1', pair: 'USD/CNY', amount: 10, utc: '2024-10-26T12:00:00Z' }],
    registry,
    tzVersion: 'fold',
    policy: 'earlier',
    rates,
  });
  const next = applyCorrection(
    ledger,
    { id: 'c1', txnId: 't1', newLocal: '2024-10-27T02:30:00' },
    { registry, rates, policy: 'earlier' }
  );
  const att = next.postings[0].attestation;
  assert.equal(att.resolution, 'ambiguous-earlier');
  assert.equal(next.postings[0].utc, Date.UTC(2024, 9, 27, 0, 30) / 1000);
});
