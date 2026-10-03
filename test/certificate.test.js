import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore, registerCase, addEvidence, revokeRevision, hydrateStore } from '../src/store.js';
import { issueCertificate, recordSetHash, canonicalize } from '../src/certificate.js';

function boot() {
  const store = createStore();
  registerCase(store, 'CB-1001');
  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'customer dispute raised twice', revision: 1 });
  addEvidence(store, { id: 'ev-2', caseId: 'CB-1001', amount: 50, text: 'dispute raised by issuer', revision: 1 });
  return store;
}

test('certificate carries case, revision, hit positions, reversal amount and record set hash', () => {
  const store = boot();
  const cert = issueCertificate(store, 'CB-1001', { type: 'near', terms: ['dispute', 'raised'], slop: 2 });

  assert.equal(cert.caseId, 'CB-1001');
  assert.equal(cert.revision, 1, 'latest revision in the case');
  assert.equal(cert.query.type, 'near');
  assert.deepEqual(cert.query.terms, ['dispute', 'raised']);
  assert.equal(cert.query.slop, 2);

  assert.ok(cert.hits.length > 0);
  for (const hit of cert.hits) {
    assert.ok(typeof hit.evidenceId === 'string');
    assert.ok(Number.isInteger(hit.revision));
    assert.ok(Number.isInteger(hit.start) && Number.isInteger(hit.end));
    assert.ok(Array.isArray(hit.positions) && hit.positions.length >= 2);
    assert.ok(hit.positions.every((p) => p >= hit.start && p <= hit.end));
  }

  assert.equal(cert.currentAmount, 150);
  assert.equal(cert.reversalAmount, 0);
  assert.match(cert.recordSetHash, /^[0-9a-f]{64}$/);

  // hash is a genuine sha256 over the canonical case record set
  const recs = store.records.filter((r) => r.caseId === 'CB-1001');
  const manual = createHash('sha256').update(canonicalize(recs), 'utf8').digest('hex');
  assert.equal(cert.recordSetHash, manual);
});

test('certificate reflects corrections and revocations; hash tracks the record set', () => {
  const store = boot();
  const before = issueCertificate(store, 'CB-1001', { type: 'phrase', terms: ['dispute', 'raised'] });

  addEvidence(store, { id: 'ev-1', caseId: 'CB-1001', amount: 100, text: 'customer dispute escalated', revision: 2 });
  const afterCorrect = issueCertificate(store, 'CB-1001', { type: 'phrase', terms: ['dispute', 'raised'] });
  assert.notEqual(afterCorrect.recordSetHash, before.recordSetHash, 'hash changes with new records');
  assert.equal(afterCorrect.revision, 2);

  revokeRevision(store, 'CB-1001', 'ev-2', 1);
  const afterRevoke = issueCertificate(store, 'CB-1001', { type: 'phrase', terms: ['dispute', 'raised'] });
  assert.equal(afterRevoke.reversalAmount, -50, 'certificate carries the reversal amount');
  assert.equal(afterRevoke.currentAmount, 100, 'revoked evidence excluded from current amount');
  assert.ok(afterRevoke.hits.every((h) => h.evidenceId !== 'ev-2'), 'revoked evidence not in current hits');

  // historical certificate still sees the revoked evidence
  const hist = issueCertificate(store, 'CB-1001', { type: 'phrase', terms: ['dispute', 'raised'] }, { revision: 1 });
  assert.equal(hist.revision, 1);
  assert.ok(hist.hits.some((h) => h.evidenceId === 'ev-2'));
});

test('certificate is deterministic for identical record sets', () => {
  const a = boot();
  const replayed = hydrateStore(a.records);
  assert.equal(recordSetHash(a, 'CB-1001'), recordSetHash(replayed, 'CB-1001'));
  const c1 = issueCertificate(a, 'CB-1001', { type: 'near', terms: ['dispute', 'raised'], slop: 2 });
  const c2 = issueCertificate(replayed, 'CB-1001', { type: 'near', terms: ['dispute', 'raised'], slop: 2 });
  assert.deepEqual(c2, c1);
});

test('certificate for unknown case raises and writes nothing', () => {
  const store = boot();
  const before = store.records.length;
  assert.throws(
    () => issueCertificate(store, 'CB-XXXX', { type: 'phrase', terms: ['x'] }),
    (err) => err.code === 'ERR_UNKNOWN_CASE',
  );
  assert.equal(store.records.length, before);
});
