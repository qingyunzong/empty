import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLedger, AuditError } from '../src/ledger.js';

function fullyAuditedLedger() {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'a', claimedNum: 100n, claimedDen: 1n });
  ledger.addItem({ id: 'b', claimedNum: 50n, claimedDen: 2n });
  ledger.addItem({ id: 'c', claimedNum: 1n, claimedDen: 3n });
  ledger.audit({ id: 'a', actualNum: 90n, actualDen: 1n }); // err -10
  ledger.audit({ id: 'b', actualNum: 30n, actualDen: 1n }); // err +5
  ledger.audit({ id: 'c', actualNum: 5n, actualDen: 6n }); // err +1/2
  return ledger;
}

test('acceptance 1: fully audited interval equals exact propagated sum', () => {
  const ledger = fullyAuditedLedger();
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 1n });
  assert.deepEqual(bound, {
    lower: '-10',
    upper: '11/2',
    status: 'ok',
    witnessIds: ['a', 'b', 'c'],
  });
  const exp = ledger.explain();
  assert.equal(exp.strata.audited.lower, '-10');
  assert.equal(exp.strata.audited.upper, '11/2');
  assert.equal(exp.strata.unaudited.count, 0);
  assert.equal(exp.strata.unaudited.status, 'ok');
});

test('confidence below 1 inflates the interval conservatively', () => {
  const ledger = fullyAuditedLedger();
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 2n });
  assert.equal(bound.lower, '-20');
  assert.equal(bound.upper, '11');
});

test('acceptance 2: partial audit is pending and excludes unaudited items', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'x', claimedNum: 10n });
  ledger.addItem({ id: 'y', claimedNum: 20n });
  ledger.addItem({ id: 'z', claimedNum: 30n });
  ledger.audit({ id: 'x', actualNum: 7n }); // err -3
  ledger.audit({ id: 'z', actualNum: 35n }); // err +5
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 1n });
  assert.equal(bound.status, 'pending');
  assert.equal(bound.code, 'E_PENDING');
  assert.equal(bound.lower, '-3');
  assert.equal(bound.upper, '5');
  assert.deepEqual(bound.witnessIds, ['x', 'z']); // y never appears
  const exp = ledger.explain();
  assert.equal(exp.strata.unaudited.count, 1);
  assert.equal(exp.strata.unaudited.status, 'E_PENDING');
  assert.deepEqual(exp.items.map((i) => i.id), ['x', 'z']);
});

test('acceptance 3: correcting an audited item updates sums and invalidates old explain', () => {
  const ledger = fullyAuditedLedger();
  const before = ledger.explain();
  assert.equal(ledger.verify(before), true);
  ledger.correct({ id: 'a', newClaimed: '95/1' }); // err -10 -> -5
  assert.equal(ledger.verify(before), false);
  assert.notEqual(before.certificate, ledger.explain().certificate);
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 1n });
  assert.equal(bound.lower, '-5');
  assert.equal(bound.upper, '11/2');
  const after = ledger.explain();
  assert.equal(ledger.verify(after), true);
  assert.equal(after.strata.audited.lower, '-5');
});

test('correction of an unaudited item leaves layer sums untouched', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'x', claimedNum: 10n });
  ledger.addItem({ id: 'y', claimedNum: 20n });
  ledger.audit({ id: 'x', actualNum: 12n });
  ledger.correct({ id: 'y', newClaimed: '25/1' });
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 1n });
  assert.equal(bound.upper, '2');
  assert.equal(bound.lower, '0');
  assert.equal(bound.status, 'pending');
});

test('re-audit replaces the previous observation exactly once', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'x', claimedNum: 10n });
  ledger.audit({ id: 'x', actualNum: 12n });
  ledger.audit({ id: 'x', actualNum: 8n });
  const bound = ledger.bound({ confidenceNum: 1n, confidenceDen: 1n });
  assert.equal(bound.lower, '-2');
  assert.equal(bound.upper, '0');
  assert.equal(ledger.auditedCount, 1);
});

test('E_LAYER: bound and explain on empty audited stratum', () => {
  const ledger = new AuditLedger();
  assert.throws(() => ledger.bound({ confidenceNum: 1n }), (e) => e instanceof AuditError && e.code === 'E_LAYER');
  assert.throws(() => ledger.explain(), (e) => e.code === 'E_LAYER');
  ledger.addItem({ id: 'x', claimedNum: 1n });
  assert.throws(() => ledger.bound({ confidenceNum: 1n }), (e) => e.code === 'E_LAYER');
});

test('E_CONF: confidence must be in (0,1]', () => {
  const ledger = fullyAuditedLedger();
  for (const [n, d] of [[0n, 1n], [-1n, 2n], [2n, 1n], [3n, 2n]]) {
    assert.throws(
      () => ledger.bound({ confidenceNum: n, confidenceDen: d }),
      (e) => e instanceof AuditError && e.code === 'E_CONF',
    );
  }
});

test('unknown and duplicate item ids are rejected', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'x', claimedNum: 1n });
  assert.throws(() => ledger.addItem({ id: 'x', claimedNum: 2n }), (e) => e.code === 'E_ITEM');
  assert.throws(() => ledger.audit({ id: 'nope', actualNum: 1n }), (e) => e.code === 'E_ITEM');
  assert.throws(() => ledger.correct({ id: 'nope', newClaimed: '1/1' }), (e) => e.code === 'E_ITEM');
});
