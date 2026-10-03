import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore, StoreError } from '../src/store.js';

function seedStore() {
  const store = new EvidenceStore();
  store.addEvidence({ id: 'E1', caseId: 'CASE-1', amount: 100, text: 'stolen card used at hotel' });
  return store;
}

function assertNoWrite(store, fn, code) {
  const before = store.recordCount;
  const err = assert.throws(fn, (e) => e instanceof StoreError && e.code === code);
  assert.equal(store.recordCount, before, 'no new records written on error');
  return err;
}

test('referencing an unknown case is an error with no writes', () => {
  const store = seedStore();
  assertNoWrite(store, () => store.queryCurrent('NOPE', { phrase: 'stolen card' }), 'UNKNOWN_CASE');
  assertNoWrite(store, () => store.queryAtRevision('NOPE', 1, { phrase: 'x' }), 'UNKNOWN_CASE');
  assertNoWrite(store, () => store.getCertificate('NOPE', { phrase: 'x' }), 'UNKNOWN_CASE');
  assertNoWrite(store, () => store.currentAmount('NOPE'), 'UNKNOWN_CASE');
  assertNoWrite(store, () => store.reversalAmount('NOPE'), 'UNKNOWN_CASE');
});

test('revision regression (倒挂) is rejected with no writes', () => {
  const store = seedStore();
  store.correctEvidence('E1', { text: 'second version' }); // revision 2
  const before = store.recordCount;
  assertNoWrite(store, () => store.correctEvidence('E1', { text: 'x', revision: 1 }), 'REVISION_REGRESSION');
  assertNoWrite(store, () => store.correctEvidence('E1', { text: 'x', revision: 2 }), 'REVISION_REGRESSION');
  assertNoWrite(store, () => store.correctEvidence('E1', { text: 'x', revision: 5 }), 'REVISION_REGRESSION');
  assertNoWrite(store, () => store.correctEvidence('E1', { text: 'x', revision: 1.5 }), 'REVISION_REGRESSION');
  assert.equal(store.recordCount, before);
  // the correct next revision still works afterwards
  const rec = store.correctEvidence('E1', { text: 'third', revision: 3 });
  assert.equal(rec.revision, 3);
});

test('revoking an already-revoked revision is an error with no writes', () => {
  const store = seedStore();
  store.revokeRevision('E1', 1);
  assertNoWrite(store, () => store.revokeRevision('E1', 1), 'ALREADY_REVOKED');
  assert.equal(store.reversalAmount('CASE-1'), -100, 'reversal recorded exactly once');
});

test('unknown evidence / revision references are errors with no writes', () => {
  const store = seedStore();
  assertNoWrite(store, () => store.correctEvidence('GHOST', { text: 'x' }), 'UNKNOWN_EVIDENCE');
  assertNoWrite(store, () => store.revokeRevision('E1', 9), 'UNKNOWN_REVISION');
  assertNoWrite(store, () => store.revokeRevision('GHOST', 1), 'UNKNOWN_REVISION');
});

test('duplicate evidence id is rejected with no writes', () => {
  const store = seedStore();
  assertNoWrite(
    store,
    () => store.addEvidence({ id: 'E1', caseId: 'CASE-1', amount: 1, text: 'dup' }),
    'DUPLICATE_EVIDENCE',
  );
});
