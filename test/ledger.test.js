import assert from 'node:assert/strict';
import test from 'node:test';
import { ERR, Ledger, LedgerError } from '../src/ledger.js';

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LedgerError, `expected LedgerError, got ${error}`);
    return error.code;
  }
  assert.fail('expected function to throw');
}

test('createBatch rejects unknown parent with E_DEPEND', () => {
  const ledger = new Ledger();
  assert.equal(
    codeOf(() => ledger.createBatch({ id: 'P', parentId: 'G', day: '2026-10-01' })),
    ERR.DEPEND,
  );
});

test('settleBatch requires settled parent (E_DEPEND)', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'G', day: '2026-10-01' });
  ledger.createBatch({ id: 'P', parentId: 'G', day: '2026-10-01' });
  assert.equal(codeOf(() => ledger.settleBatch('P')), ERR.DEPEND);
  ledger.settleBatch('G');
  ledger.settleBatch('P');
  assert.equal(ledger.batches.get('P').status, 'settled');
});

test('addTx to a closed day fails with E_BOUNDARY', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.closeDay('2026-10-01');
  assert.equal(
    codeOf(() => ledger.addTx({ id: 'T1', batchId: 'B', account: 'a', amount: 1, day: '2026-10-01' })),
    ERR.BOUNDARY,
  );
});

test('duplicate savepoint id fails with E_SNAP', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  assert.equal(codeOf(() => ledger.createSavepoint({ id: 'SP', batchId: 'B' })), ERR.SNAP);
});

test('savepoint on missing batch fails with E_SNAP', () => {
  const ledger = new Ledger();
  assert.equal(codeOf(() => ledger.createSavepoint({ id: 'SP', batchId: 'NOPE' })), ERR.SNAP);
});

test('rollback of unknown savepoint fails with E_SNAP', () => {
  const ledger = new Ledger();
  assert.equal(codeOf(() => ledger.planRollback('NOPE')), ERR.SNAP);
});

test('stale plan execution fails with E_SNAP', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'a', amount: 5, day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  const plan = ledger.planRollback('SP');
  ledger.addTx({ id: 'T2', batchId: 'B', account: 'a', amount: 7, day: '2026-10-01' });
  assert.equal(codeOf(() => ledger.executeRollback(plan)), ERR.SNAP);
});

test('correcting an already corrected tx fails with E_DEPEND', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'a', amount: 5, day: '2026-10-01' });
  ledger.addTx({ id: 'C1', batchId: 'B', account: 'a', amount: 6, day: '2026-10-01', corrects: 'T1' });
  assert.equal(
    codeOf(() => ledger.addTx({ id: 'C2', batchId: 'B', account: 'a', amount: 7, day: '2026-10-01', corrects: 'T1' })),
    ERR.DEPEND,
  );
});

test('dangling restore: savepoint of rolled-back descendant fails with E_SNAP', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'G', day: '2026-10-01' });
  ledger.addTx({ id: 'T0', batchId: 'G', account: 'a', amount: 1, day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SPG', batchId: 'G' });
  ledger.createBatch({ id: 'P', parentId: 'G', day: '2026-10-01' });
  ledger.addTx({ id: 'T1', batchId: 'P', account: 'a', amount: 2, day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SPP', batchId: 'P' });
  const plan = ledger.planRollback('SPG');
  ledger.executeRollback(plan);
  assert.equal(ledger.batches.get('P').status, 'rolledback');
  assert.equal(codeOf(() => ledger.planRollback('SPP')), ERR.SNAP);
});

test('corrections of surviving txs are carried forward, not resurrected', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'a', amount: 100, day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  ledger.addTx({ id: 'C1', batchId: 'B', account: 'a', amount: 40, day: '2026-10-01', corrects: 'T1' });
  ledger.addTx({ id: 'T2', batchId: 'B', account: 'a', amount: 5, day: '2026-10-01' });
  const plan = ledger.planRollback('SP');
  assert.deepEqual(plan.carryForward, ['C1']);
  assert.deepEqual(plan.removals, ['T2']);
  ledger.executeRollback(plan);
  assert.equal(ledger.txs.get('T1').status, 'corrected');
  assert.equal(ledger.txs.get('C1').status, 'active');
  assert.deepEqual(ledger.balances(), { a: 40 });
});

test('correction is rolled back together with its removed target', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'a', amount: 100, day: '2026-10-01' });
  ledger.addTx({ id: 'C1', batchId: 'B', account: 'a', amount: 40, day: '2026-10-01', corrects: 'T1' });
  const plan = ledger.planRollback('SP');
  assert.deepEqual(plan.removals.sort(), ['C1', 'T1']);
  assert.deepEqual(plan.carryForward, []);
  ledger.executeRollback(plan);
  assert.deepEqual(ledger.balances(), {});
});

test('hash is deterministic and survives JSON round-trip', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'G', day: '2026-10-01' });
  ledger.createBatch({ id: 'P', parentId: 'G', day: '2026-10-01' });
  ledger.addTx({ id: 'T1', batchId: 'G', account: 'a', amount: 10, day: '2026-10-01' });
  ledger.addTx({ id: 'T2', batchId: 'P', account: 'b', amount: 20, day: '2026-10-01' });
  ledger.createSavepoint({ id: 'SP', batchId: 'G' });
  const clone = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.equal(clone.hash(), ledger.hash());
  assert.deepEqual(clone.balances(), ledger.balances());
});
