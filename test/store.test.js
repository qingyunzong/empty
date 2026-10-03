import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore, registerCase, addEvidence, revokeRevision,
  search, caseAmounts, getEvidence, StoreError,
} from '../src/store.js';

function boot() {
  const store = createStore();
  registerCase(store, 'CB-1001');
  registerCase(store, 'CB-2002');
  return store;
}

test('correction appends a new revision and changes current results; history is preserved', () => {
  const store = boot();
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'refund promised by merchant', revision: 1 });

  let hits = search(store, 'CB-1001', { type: 'phrase', terms: ['refund', 'promised'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].revision, 1);

  // correction: new revision, old one untouched
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 250, text: 'chargeback confirmed by issuer', revision: 2 });

  hits = search(store, 'CB-1001', { type: 'phrase', terms: ['refund', 'promised'] });
  assert.equal(hits.length, 0, 'current view no longer matches old text');
  hits = search(store, 'CB-1001', { type: 'phrase', terms: ['chargeback', 'confirmed'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].revision, 2);
  assert.equal(caseAmounts(store, 'CB-1001').currentAmount, 250);

  // historical query at revision 1 still sees the old text and amount
  const hist = search(store, 'CB-1001', { type: 'phrase', terms: ['refund', 'promised'] }, { revision: 1 });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].revision, 1);
  assert.equal(getEvidence(store, 'CB-1001', 'ev-1', 1).amount, 100);
});

test('revocation adds a tombstone with reversal amount and excludes the revision from current view', () => {
  const store = boot();
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'alpha beta', revision: 1 });
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 250, text: 'gamma beta', revision: 2 });
  addEvidence(store, { id: 'ev-2', caseId: 'CB-1001', amount: 40, text: 'gamma delta', revision: 1 });

  const tomb = revokeRevision(store, 'CB-1001', 'ev-1', 2);
  assert.equal(tomb.type, 'tombstone');
  assert.equal(tomb.reversalAmount, -250, 'reversal is the negation of the revoked amount');

  const amounts = caseAmounts(store, 'CB-1001');
  assert.equal(amounts.reversalAmount, -250);
  // current falls back to the latest non-revoked revision (rev 1 = 100) plus ev-2 (40)
  assert.equal(amounts.currentAmount, 140, 'revoked amount no longer counted');

  // current search uses rev 1 text; revoked rev 2 text is gone from current view
  assert.equal(search(store, 'CB-1001', { type: 'phrase', terms: ['gamma', 'beta'] }).length, 0);
  const hits = search(store, 'CB-1001', { type: 'phrase', terms: ['alpha', 'beta'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].revision, 1);

  // revoked revision remains queryable as history
  const hist = search(store, 'CB-1001', { type: 'phrase', terms: ['gamma'] }, { revision: 2 });
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((h) => [h.evidenceId, h.revision]), [['ev-1', 2], ['ev-2', 1]]);
  const histPhrase = search(store, 'CB-1001', { type: 'phrase', terms: ['gamma', 'beta'] }, { revision: 2 });
  assert.equal(histPhrase.length, 1);
  assert.equal(histPhrase[0].revision, 2);
});

test('unknown case, revision regression and double revocation fail without new writes', () => {
  const store = boot();
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'alpha', revision: 1 });
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'beta', revision: 2 });
  revokeRevision(store, 'CB-1001', 'ev-1', 1);

  const expectNoWrite = (fn, code) => {
    const before = store.records.length;
    const seqBefore = store.seq;
    assert.throws(fn, (err) => err instanceof StoreError && err.code === code);
    assert.equal(store.records.length, before, `${code}: no record appended`);
    assert.equal(store.seq, seqBefore, `${code}: sequence untouched`);
  };

  expectNoWrite(
    () => addEvidence(store, { id: 'ev-9', caseId: 'CB-9999', amount: 1, text: 'x', revision: 1 }),
    'ERR_UNKNOWN_CASE',
  );
  expectNoWrite(
    () => search(store, 'CB-9999', { type: 'phrase', terms: ['x'] }),
    'ERR_UNKNOWN_CASE',
  );
  expectNoWrite(
    () => revokeRevision(store, 'CB-9999', 'ev-1', 1),
    'ERR_UNKNOWN_CASE',
  );
  // revision regression: same and lower revision numbers are rejected
  expectNoWrite(
    () => addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 1, text: 'x', revision: 2 }),
    'ERR_REVISION_REGRESSION',
  );
  expectNoWrite(
    () => addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 1, text: 'x', revision: 1 }),
    'ERR_REVISION_REGRESSION',
  );
  // double revocation
  expectNoWrite(() => revokeRevision(store, 'CB-1001', 'ev-1', 1), 'ERR_ALREADY_REVOKED');
  // unknown evidence / revision
  expectNoWrite(() => revokeRevision(store, 'CB-1001', 'ev-x', 1), 'ERR_UNKNOWN_EVIDENCE');
  expectNoWrite(() => revokeRevision(store, 'CB-1001', 'ev-1', 7), 'ERR_UNKNOWN_REVISION');
});

test('revision gaps are rejected', () => {
  const store = boot();
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 1, text: 'a', revision: 1 });
  assert.throws(
    () => addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 1, text: 'b', revision: 3 }),
    (err) => err.code === 'ERR_REVISION_GAP',
  );
});

test('cases are isolated from each other', () => {
  const store = boot();
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 10, text: 'shared terms here', revision: 1 });
  addEvidence(store, { id: 'ev-1', caseId: 'CB-2002', amount: 20, text: 'shared terms here', revision: 1 });
  assert.equal(search(store, 'CB-1001', { type: 'phrase', terms: ['shared', 'terms'] }).length, 1);
  assert.equal(caseAmounts(store, 'CB-2002').currentAmount, 20);
  revokeRevision(store, 'CB-2002', 'ev-1', 1);
  assert.equal(caseAmounts(store, 'CB-1001').currentAmount, 10, 'other case unaffected');
  assert.equal(caseAmounts(store, 'CB-1001').reversalAmount, 0);
});
