import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError, buildCertificate } from '../src/core.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rand) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildScenario() {
  const ledger = new Ledger();
  ledger.createBatch({
    batchId: 'B-100',
    requestId: 'req-create-1',
    entries: [
      { accountId: 'acc-alice', amount: 1000 },
      { accountId: 'acc-bob', amount: -400 },
      { accountId: 'acc-carol', amount: -600 },
    ],
  });
  ledger.applyCorrection({
    batchId: 'B-100',
    baseVersion: 1,
    requestId: 'req-corr-2',
    corrections: [
      { op: 'add', accountId: 'acc-alice', amount: 250 },
      { op: 'reverse', entryId: 'e3' },
      { op: 'adjust', entryId: 'e2', amount: -450 },
    ],
  });
  ledger.applyCorrection({
    batchId: 'B-100',
    baseVersion: 2,
    requestId: 'req-corr-3',
    corrections: [
      { op: 'add', accountId: 'acc-dave', amount: 125 },
      { op: 'adjust', entryId: 'e1', amount: 900 },
    ],
  });
  const confirmed = ledger.confirmBatch({ batchId: 'B-100', requestId: 'req-confirm-1' });
  return { ledger, confirmed };
}

test('two consecutive corrections settle at the final-version net amounts', () => {
  const { ledger, confirmed } = buildScenario();
  assert.equal(confirmed.version, 3);
  assert.deepEqual(confirmed.certificate.nets, [
    { accountId: 'acc-alice', amount: 1150 },
    { accountId: 'acc-bob', amount: -450 },
    { accountId: 'acc-carol', amount: 0 },
    { accountId: 'acc-dave', amount: 125 },
  ]);
  const view = ledger.getBatch('B-100');
  assert.deepEqual(view.nets, confirmed.certificate.nets);
  assert.equal(view.state, 'CONFIRMED');
  assert.equal(
    confirmed.certificate.hash,
    buildCertificate('B-100', 3, view.entries).hash,
  );
});

test('out-of-order replay of the full history yields the same certificate', () => {
  const { ledger, confirmed } = buildScenario();
  const events = ledger.events;
  const rand = mulberry32(42);
  for (let round = 0; round < 25; round += 1) {
    const replayed = Ledger.replay(shuffled(events, rand));
    const view = replayed.getBatch('B-100');
    assert.equal(view.state, 'CONFIRMED');
    assert.deepEqual(replayed.getCertificate('B-100'), confirmed.certificate);
    assert.equal(
      buildCertificate('B-100', confirmed.version, view.entries).hash,
      confirmed.certificate.hash,
    );
  }
});

test('revoke after confirmation zeroes every account and keeps the audit chain', () => {
  const { ledger, confirmed } = buildScenario();
  const entriesBefore = ledger.getBatch('B-100').entries.length;
  const revoked = ledger.revokeBatch({ batchId: 'B-100', requestId: 'req-revoke-1' });
  assert.equal(revoked.state, 'COMPENSATED');
  assert.ok(revoked.compensationEntries.length > 0);
  for (const net of revoked.nets) {
    assert.equal(net.amount, 0, `account ${net.accountId} must net to zero`);
  }
  const view = ledger.getBatch('B-100');
  assert.equal(view.state, 'COMPENSATED');
  assert.ok(view.entries.length > entriesBefore, 'history must be kept, not deleted');
  assert.deepEqual(view.certificate, confirmed.certificate, 'certificate stays on record');
  const trail = ledger.auditTrail('B-100').map((event) => event.type);
  assert.deepEqual(trail, [
    'BATCH_CREATED',
    'CORRECTION_APPLIED',
    'CORRECTION_APPLIED',
    'BATCH_CONFIRMED',
    'COMPENSATION_APPLIED',
  ]);
});

test('revoke before confirmation releases the freeze', () => {
  const ledger = new Ledger();
  ledger.createBatch({
    batchId: 'B-200',
    requestId: 'req-create',
    entries: [
      { accountId: 'acc-a', amount: 700 },
      { accountId: 'acc-b', amount: -700 },
    ],
  });
  const revoked = ledger.revokeBatch({ batchId: 'B-200', requestId: 'req-revoke' });
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(revoked.releasedFreeze, 0);
  assert.throws(
    () =>
      ledger.applyCorrection({
        batchId: 'B-200',
        baseVersion: 1,
        requestId: 'req-late',
        corrections: [{ op: 'add', accountId: 'acc-a', amount: 1 }],
      }),
    (error) => error instanceof LedgerError && error.code === 'INVALID_STATE',
  );
});

test('stale version resubmission returns VERSION_CONFLICT and does not mutate', () => {
  const ledger = new Ledger();
  ledger.createBatch({
    batchId: 'B-300',
    requestId: 'req-create',
    entries: [{ accountId: 'acc-a', amount: 100 }],
  });
  ledger.applyCorrection({
    batchId: 'B-300',
    baseVersion: 1,
    requestId: 'req-corr',
    corrections: [{ op: 'add', accountId: 'acc-a', amount: 50 }],
  });
  const eventsBefore = ledger.events.length;
  assert.throws(
    () =>
      ledger.applyCorrection({
        batchId: 'B-300',
        baseVersion: 1,
        requestId: 'req-stale',
        corrections: [{ op: 'add', accountId: 'acc-a', amount: 999 }],
      }),
    (error) => error instanceof LedgerError && error.code === 'VERSION_CONFLICT',
  );
  assert.equal(ledger.events.length, eventsBefore, 'rejected correction must not append events');
  assert.deepEqual(ledger.getBatch('B-300').nets, [{ accountId: 'acc-a', amount: 150 }]);
});

test('duplicate submission of the same request returns the original result', () => {
  const ledger = new Ledger();
  const created = ledger.createBatch({
    batchId: 'B-400',
    requestId: 'req-create',
    entries: [{ accountId: 'acc-a', amount: 100 }],
  });
  const corrected = ledger.applyCorrection({
    batchId: 'B-400',
    baseVersion: 1,
    requestId: 'req-corr',
    corrections: [{ op: 'add', accountId: 'acc-b', amount: -40 }],
  });
  const eventsBefore = ledger.events.length;
  assert.deepEqual(
    ledger.createBatch({
      batchId: 'B-400',
      requestId: 'req-create',
      entries: [{ accountId: 'acc-a', amount: 100 }],
    }),
    created,
  );
  assert.deepEqual(
    ledger.applyCorrection({
      batchId: 'B-400',
      baseVersion: 1,
      requestId: 'req-corr',
      corrections: [{ op: 'add', accountId: 'acc-b', amount: -40 }],
    }),
    corrected,
  );
  assert.equal(ledger.events.length, eventsBefore, 'duplicates must not append events');
});
