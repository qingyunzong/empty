import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaim } from '../src/verify.js';
import { issueCert, checkCert } from '../src/cert.js';
import { memStore } from './helpers.mjs';

const kycCount = (n) => ({
  where: [{ field: 'type', op: 'eq', value: 'kyc' }],
  aggregate: { op: 'count', field: '*' },
  expect: { op: 'gte', value: n },
});

test('acceptance 2: retraction turns pass into undecided, not fail', () => {
  const store = memStore([
    { key: 'd1', attrs: { type: 'kyc' } },
    { key: 'd2', attrs: { type: 'kyc' } },
    { key: 'd3', attrs: { type: 'kyc' } },
  ]);
  assert.equal(evaluateClaim(store, kycCount(3)).conclusion, 'pass');
  store.retract('d3');
  const after = evaluateClaim(store, kycCount(3));
  assert.equal(after.conclusion, 'undecided'); // withdrawn evidence != counter-evidence
  assert.notEqual(after.conclusion, 'fail');
  assert.deepEqual(after.retracted, ['d3']);
});

test('acceptance 3: all best rules listed when priorities tie', () => {
  const store = memStore(
    [{ key: 'x', attrs: { kind: 'a', flag: 1 } }],
    [
      { id: 'ra', priority: 7, where: [{ field: 'kind', op: 'eq', value: 'a' }] },
      { id: 'rb', priority: 7, where: [{ field: 'flag', op: 'eq', value: 1 }] },
      { id: 'rc', priority: 3, where: [{ field: 'kind', op: 'eq', value: 'a' }] },
    ]
  );
  const r = evaluateClaim(store, { aggregate: { op: 'count', field: '*' }, expect: { op: 'gte', value: 0 } });
  assert.deepEqual(r.bestRules, [
    { id: 'ra', priority: 7 },
    { id: 'rb', priority: 7 },
  ]); // rc excluded (lower priority), both ties present
});

test('acceptance 4: certificate tampering is detected', () => {
  const store = memStore([
    { key: 'd1', attrs: { type: 'kyc' } },
    { key: 'd2', attrs: { type: 'kyc' } },
    { key: 'u1', state: 'unknown', attrs: { type: 'kyc' } },
  ]);
  const cert = issueCert(store, kycCount(2), '2026-10-02T00:00:00.000Z');
  assert.deepEqual(cert.undecided, ['u1']); // non-empty, so clearing it is a real tamper
  assert.deepEqual(checkCert(store, cert).ok, true);

  const tampers = {
    'conclusion flipped': { ...cert, conclusion: 'fail' },
    'hit key added': { ...cert, hitEvidenceKeys: [...cert.hitEvidenceKeys, 'ghost'] },
    'undecided cleared': { ...cert, undecided: [] },
    'ruleVersion bumped': { ...cert, ruleVersion: cert.ruleVersion + 1 },
    'hash truncated': { ...cert, hash: cert.hash.slice(0, 16) },
    'claim altered': { ...cert, claim: kycCount(1) },
  };
  for (const [name, bad] of Object.entries(tampers)) {
    assert.throws(() => checkCert(store, bad), (e) => e.code === 'E_CERT_MISMATCH', name);
  }
  // Staleness: pack changes after issuance invalidate the cert too.
  store.retract('d2');
  assert.throws(() => checkCert(store, cert), (e) => e.code === 'E_CERT_MISMATCH', 'stale input');
});
