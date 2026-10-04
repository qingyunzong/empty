import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError } from '../src/ledger.js';

function openLedger(limit = 1000) {
  const ledger = new Ledger();
  ledger.apply({ op: 'open_account', accountId: 'acct', creditLimit: limit });
  return ledger;
}

test('boundary: freeze exactly equal to available credit', () => {
  const ledger = openLedger(1000);
  const rec = ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 1000, requestId: 'r1' });
  assert.equal(ledger.available('acct'), 0);
  assert.equal(ledger.held('acct'), 1000);
  assert.equal(rec.deltas.available, -1000);
});

test('INSUFFICIENT beyond available produces no partial state', () => {
  const ledger = openLedger(1000);
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 1000 });
  const before = ledger.snapshot();
  const journalLen = ledger.journal.length;
  assert.throws(
    () => ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A2', amount: 1 }),
    (e) => e instanceof LedgerError && e.code === 'INSUFFICIENT',
  );
  assert.equal(ledger.journal.length, journalLen); // no event recorded
  assert.deepEqual(ledger.snapshot(), before); // state untouched
});

test('release may not exceed remaining frozen amount', () => {
  const ledger = openLedger(500);
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 200 });
  ledger.apply({ op: 'release', accountId: 'acct', authId: 'A1', amount: 150 });
  assert.equal(ledger.available('acct'), 450);
  assert.throws(
    () => ledger.apply({ op: 'release', accountId: 'acct', authId: 'A1', amount: 51 }),
    (e) => e.code === 'EXCEEDS_HELD',
  );
  ledger.apply({ op: 'release', accountId: 'acct', authId: 'A1', amount: 50 });
  assert.equal(ledger.available('acct'), 500);
});

test('reverse of a partially settled authorization', () => {
  const ledger = openLedger(1000);
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 400 });
  ledger.apply({ op: 'capture', accountId: 'acct', authId: 'A1', amount: 150, merchantId: 'm1' });
  const rec = ledger.apply({ op: 'reverse', accountId: 'acct', authId: 'A1' });
  // remaining 250 frozen is voided; the 150 captured stays posted
  assert.equal(rec.deltas.available, 250);
  assert.equal(ledger.available('acct'), 850);
  assert.equal(ledger.held('acct'), 0);
  assert.equal(ledger.settled('m1'), 150);
  // closed auth rejects further operations
  assert.throws(() => ledger.apply({ op: 'capture', accountId: 'acct', authId: 'A1', amount: 1 }),
    (e) => e.code === 'AUTH_CLOSED');
  // invalidation propagation: authId is reusable after reversal
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 100 });
  assert.equal(ledger.held('acct'), 100);
  assert.equal(ledger.available('acct'), 750);
});

test('split and merge conserve frozen totals', () => {
  const ledger = openLedger(1000);
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 300 });
  ledger.apply({ op: 'split', accountId: 'acct', authId: 'A1', into: [
    { authId: 'A1a', amount: 120 }, { authId: 'A1b', amount: 180 },
  ]});
  assert.equal(ledger.held('acct'), 300);
  ledger.apply({ op: 'capture', accountId: 'acct', authId: 'A1a', amount: 20, merchantId: 'm1' });
  ledger.apply({ op: 'merge', accountId: 'acct', from: ['A1a', 'A1b'], into: 'A1c' });
  assert.equal(ledger.held('acct'), 280);
  const snap = ledger.snapshot();
  const a1c = snap.accounts[0].openAuthorizations.find((h) => h.authId === 'A1c');
  assert.equal(a1c.held, 280);
  // split with mismatched sum fails without state change
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'B1', amount: 100 });
  const before = ledger.snapshot();
  assert.throws(() => ledger.apply({ op: 'split', accountId: 'acct', authId: 'B1', into: [
    { authId: 'B1a', amount: 60 }, { authId: 'B1b', amount: 60 },
  ]}), (e) => e.code === 'EXCEEDS_HELD');
  assert.deepEqual(ledger.snapshot(), before);
});

test('deterministic recompute: every prefix replay matches incremental state', () => {
  const events = [
    { op: 'open_account', accountId: 'acct', creditLimit: 900 },
    { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 300, requestId: 'r1' },
    { op: 'authorize', accountId: 'acct', authId: 'A2', amount: 200, requestId: 'r2' },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 100, merchantId: 'm1', requestId: 'r3' },
    { op: 'release', accountId: 'acct', authId: 'A2', amount: 50, requestId: 'r4' },
    { op: 'split', accountId: 'acct', authId: 'A1', into: [{ authId: 'A1a', amount: 80 }, { authId: 'A1b', amount: 120 }], requestId: 'r5' },
    { op: 'capture', accountId: 'acct', authId: 'A1b', amount: 120, merchantId: 'm2', requestId: 'r6' },
    { op: 'reverse', accountId: 'acct', authId: 'A2', requestId: 'r7' },
    { op: 'authorize', accountId: 'acct', authId: 'A2', amount: 40, requestId: 'r8' },
    { op: 'merge', accountId: 'acct', from: ['A1a', 'A2'], into: 'AX', requestId: 'r9' },
  ];
  const incremental = new Ledger();
  for (let k = 0; k <= events.length; k++) {
    const replayed = Ledger.replay(events, k);
    assert.deepEqual(replayed.snapshot(), incremental.snapshot(), `prefix ${k} mismatch`);
    if (k < events.length) incremental.apply(events[k]);
  }
});

test('every change record explains its source', () => {
  const ledger = openLedger(500);
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 200, requestId: 'r1' });
  ledger.apply({ op: 'capture', accountId: 'acct', authId: 'A1', amount: 80, merchantId: 'm1', requestId: 'r2' });
  ledger.apply({ op: 'reverse', accountId: 'acct', authId: 'A1', requestId: 'r3' });
  assert.equal(ledger.journal.length, 4);
  for (const rec of ledger.journal) {
    assert.equal(typeof rec.reason, 'string');
    assert.ok(rec.reason.length > 0);
    assert.ok('held' in rec.deltas && 'available' in rec.deltas && 'posted' in rec.deltas);
  }
  assert.deepEqual(ledger.journal.map((r) => r.seq), [0, 1, 2, 3]);
});
