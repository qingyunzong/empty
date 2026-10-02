import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balancesObject, txnEntries } from '../src/index.js';
import { makeTxn, makeLedgerJson, runPlanInMemory } from './helpers.js';

test('scenario 1a: normal revoke of a SETTLED txn posts paired reversal entries', () => {
  const ledgerJson = makeLedgerJson([
    ...makeTxn('txn:1', 'acct:alice', 'acct:revenue', '100.00', 'SETTLED', 1),
  ]);
  const { ledger, counts } = runPlanInMemory('revoke txn:1;', ledgerJson);
  assert.deepEqual(counts, { reversed: 1, compensated: 0, cancelRequested: 0, skipped: 0 });
  const entries = txnEntries(ledger, 'txn:1');
  const originals = entries.filter((e) => e.kind == null);
  const mirrors = entries.filter((e) => e.kind === 'reversal');
  assert.equal(originals.length, 2);
  assert.equal(mirrors.length, 2);
  assert.ok(originals.every((e) => e.status === 'REVERSED'));
  assert.ok(mirrors.every((e) => e.status === 'SETTLED'));
  // debit/credit pairing: every mirror flips its original
  for (const m of mirrors) {
    const orig = originals.find((e) => e.id === m.ref);
    assert.ok(orig, 'mirror references an original entry');
    assert.equal(m.account, orig.account);
    assert.equal(m.amountCents, orig.amountCents);
    assert.notEqual(m.dc, orig.dc);
  }
  assert.deepEqual(balancesObject(ledger), { 'acct:alice': 0, 'acct:revenue': 0 });
});

test('scenario 1b: cross-day LOCKED entries are compensated, never physically deleted', () => {
  const ledgerJson = makeLedgerJson([
    ...makeTxn('txn:1', 'acct:alice', 'acct:revenue', '100.00', 'SETTLED', 1),
    ...makeTxn('txn:2', 'acct:bob', 'acct:revenue', '40.00', 'LOCKED', 0),
  ]);
  const { ledger, counts } = runPlanInMemory('for tx in txns(txn:1, txn:2) { revoke tx; }', ledgerJson);
  assert.deepEqual(counts, { reversed: 1, compensated: 1, cancelRequested: 0, skipped: 0 });
  const locked = txnEntries(ledger, 'txn:2');
  const originals = locked.filter((e) => e.kind == null);
  const comps = locked.filter((e) => e.kind === 'compensation');
  assert.equal(originals.length, 2, 'original locked entries are still on the books');
  assert.ok(originals.every((e) => e.status === 'LOCKED'), 'locked entries keep their status');
  assert.equal(comps.length, 2, 'compensation entries were generated');
  assert.ok(comps.every((e) => e.status === 'SETTLED' && e.day === ledger.currentDay));
  const bal = balancesObject(ledger);
  assert.equal(bal['acct:bob'], 0, 'locked txn nets to zero via compensation');
  assert.equal(bal['acct:revenue'], 0);
  assert.equal(bal['acct:alice'], 0);
});

test('scenario 1c: PENDING txn is marked CANCEL_REQUESTED, not treated as failure', () => {
  const ledgerJson = makeLedgerJson([
    ...makeTxn('txn:1', 'acct:carol', 'acct:revenue', '25.00', 'PENDING', 2),
  ]);
  const { ledger, counts } = runPlanInMemory('revoke txn:1;', ledgerJson);
  assert.deepEqual(counts, { reversed: 0, compensated: 0, cancelRequested: 1, skipped: 0 });
  const entries = txnEntries(ledger, 'txn:1');
  assert.equal(entries.length, 2, 'no phantom success entries were created');
  assert.ok(entries.every((e) => e.status === 'CANCEL_REQUESTED'));
  assert.deepEqual(balancesObject(ledger), {}, 'pending txns never posted, balances untouched');
});

test('scenario 1d: mixed batch handles all three kinds in one plan', () => {
  const ledgerJson = makeLedgerJson([
    ...makeTxn('txn:1', 'acct:a', 'acct:r', '10.00', 'SETTLED', 1),
    ...makeTxn('txn:2', 'acct:b', 'acct:r', '20.00', 'LOCKED', 0),
    ...makeTxn('txn:3', 'acct:c', 'acct:r', '30.00', 'PENDING', 2),
  ]);
  const plan = 'for tx in txns(*) { revoke tx; }';
  const { counts } = runPlanInMemory(plan, ledgerJson);
  assert.deepEqual(counts, { reversed: 1, compensated: 1, cancelRequested: 1, skipped: 0 });
});

test('intraday lock raises E_LOCK with txnId and pc', () => {
  const ledgerJson = makeLedgerJson([
    ...makeTxn('txn:9', 'acct:a', 'acct:r', '5.00', 'LOCKED', 2),
  ], 2);
  assert.throws(
    () => runPlanInMemory('revoke txn:9;', ledgerJson),
    (e) => e.code === 'E_LOCK' && e.txnId === 'txn:9' && typeof e.pc === 'number',
  );
});
