import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../src/store.js';

function seedStore() {
  const store = new EvidenceStore();
  store.addEvidence({ id: 'E1', caseId: 'CASE-1', amount: 100, text: 'stolen card used at hotel' });
  store.addEvidence({ id: 'E2', caseId: 'CASE-1', amount: 250, text: 'card not present transaction' });
  return store;
}

test('correction appends a new revision and changes current results', () => {
  const store = seedStore();
  const before = store.queryCurrent('CASE-1', { phrase: 'stolen card' });
  assert.equal(before.hits.length, 1);

  const rec = store.correctEvidence('E1', { text: 'cardholder verified the hotel stay' });
  assert.equal(rec.revision, 2);

  const after = store.queryCurrent('CASE-1', { phrase: 'stolen card' });
  assert.equal(after.hits.length, 0, 'old text no longer matches current view');
  const now = store.queryCurrent('CASE-1', { phrase: 'cardholder verified' });
  assert.deepEqual(now.hits.map((h) => [h.evidenceId, h.revision]), [['E1', 2]]);
});

test('historical revision query is unchanged after correction', () => {
  const store = seedStore();
  const historyBefore = store.queryAtRevision('CASE-1', 1, { phrase: 'stolen card' });
  store.correctEvidence('E1', { text: 'completely different wording now' });
  const historyAfter = store.queryAtRevision('CASE-1', 1, { phrase: 'stolen card' });
  assert.deepEqual(historyAfter, historyBefore);
  assert.deepEqual(historyAfter.hits.map((h) => [h.evidenceId, h.revision]), [['E1', 1]]);
});

test('revocation adds a tombstone with reversal amount and excludes amount from current', () => {
  const store = seedStore();
  assert.equal(store.currentAmount('CASE-1'), 350);

  const tomb = store.revokeRevision('E2', 1);
  assert.equal(tomb.kind, 'tombstone');
  assert.equal(tomb.reversalAmount, -250);

  assert.equal(store.currentAmount('CASE-1'), 100, 'revoked amount no longer counted');
  assert.equal(store.reversalAmount('CASE-1'), -250);

  const hits = store.queryCurrent('CASE-1', { phrase: 'card not present' });
  assert.equal(hits.hits.length, 0, 'revoked evidence leaves the current view');

  // history still queryable
  const history = store.queryAtRevision('CASE-1', 1, { phrase: 'card not present' });
  assert.equal(history.hits.length, 1);
});

test('revoking latest revision falls back to latest non-revoked revision', () => {
  const store = seedStore();
  store.correctEvidence('E1', { amount: 120, text: 'stolen card used at hotel' });
  store.revokeRevision('E1', 2);
  assert.equal(store.currentAmount('CASE-1'), 350, 'E1 falls back to rev1 (100) plus E2 (250)');
  const docs = store.currentDocuments('CASE-1');
  const e1 = docs.find((d) => d.id === 'E1');
  assert.equal(e1.revision, 1, 'falls back to revision 1');
  assert.equal(e1.amount, 100);
  assert.equal(store.reversalAmount('CASE-1'), -120);
});

test('certificate contains case, revision, hit positions, reversal amount and record-set hash', () => {
  const store = seedStore();
  store.correctEvidence('E1', { text: 'stolen card used at casino' });
  store.revokeRevision('E2', 1);

  const cert = store.getCertificate('CASE-1', { near: 'stolen card casino', slop: 2 });
  assert.equal(cert.caseId, 'CASE-1');
  assert.equal(cert.revision, 2, 'max revision across the case record set');
  assert.equal(cert.hits.length, 1);
  assert.deepEqual(cert.hits[0].positions, [0, 1, 4]);
  assert.deepEqual(cert.hits[0].window, [0, 4]);
  assert.equal(cert.reversalAmount, -250);
  assert.equal(cert.currentAmount, 100);
  assert.match(cert.recordSetHash, /^[0-9a-f]{64}$/);

  // hash is stable for identical record sets and changes with new writes
  const again = store.getCertificate('CASE-1', { near: 'stolen card casino', slop: 2 });
  assert.equal(again.recordSetHash, cert.recordSetHash);
  store.addEvidence({ id: 'E3', caseId: 'CASE-1', amount: 10, text: 'extra' });
  const after = store.getCertificate('CASE-1', { near: 'stolen card casino', slop: 2 });
  assert.notEqual(after.recordSetHash, cert.recordSetHash);
});

test('store survives JSON round-trip (CLI persistence path)', () => {
  const store = seedStore();
  store.correctEvidence('E1', { text: 'updated wording' });
  store.revokeRevision('E2', 1);
  const restored = EvidenceStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.deepEqual(restored.toJSON(), store.toJSON());
  assert.equal(restored.currentAmount('CASE-1'), store.currentAmount('CASE-1'));
  assert.equal(restored.reversalAmount('CASE-1'), -250);
});
