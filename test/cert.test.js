import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCert, checkCert } from '../src/cert.js';
import { memStore } from './helpers.mjs';

const claim = {
  where: [{ field: 'type', op: 'eq', value: 'kyc' }],
  aggregate: { op: 'count', field: '*' },
  expect: { op: 'gte', value: 2 },
};

test('cert contains input hash, rule version, hit keys and undecided items', () => {
  const store = memStore(
    [
      { key: 'd1', attrs: { type: 'kyc' } },
      { key: 'd2', attrs: { type: 'kyc' } },
      { key: 'd3', attrs: { type: 'kyc' } },
      { key: 'u1', state: 'unknown', attrs: { type: 'other' } },
    ],
    [{ id: 'r1', priority: 2, where: [{ field: 'type', op: 'eq', value: 'junk' }] }]
  );
  const cert = issueCert(store, claim, '2026-10-02T00:00:00.000Z');
  assert.equal(cert.format, 'evpack-cert/1');
  assert.equal(cert.conclusion, 'pass');
  assert.equal(cert.inputHash, store.inputHash());
  assert.equal(cert.ruleVersion, 1);
  assert.deepEqual(cert.hitEvidenceKeys, ['d1', 'd2', 'd3']);
  assert.deepEqual(cert.undecided, []);
  assert.equal(typeof cert.hash, 'string');
  assert.equal(cert.issuedAt, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(checkCert(store, cert).ok, true);
});

test('cert records matching unknown rows as undecided items', () => {
  const store = memStore([
    { key: 'd1', attrs: { type: 'kyc' } },
    { key: 'd2', attrs: { type: 'kyc' } },
    { key: 'u1', state: 'unknown', attrs: { type: 'kyc' } },
  ]);
  // threshold 2: pass regardless of u1, but u1 is listed for review
  const cert = issueCert(store, claim);
  assert.equal(cert.conclusion, 'pass');
  assert.deepEqual(cert.undecided, ['u1']);
});

test('E_UNDECIDED: cannot certify an undecided claim', () => {
  const store = memStore([
    { key: 'd1', attrs: { type: 'kyc' } },
    { key: 'u1', state: 'unknown', attrs: { type: 'kyc' } },
  ]);
  assert.throws(() => issueCert(store, claim), (e) => e.code === 'E_UNDECIDED');
});

test('fail conclusions are certifiable (reviewable negative record)', () => {
  const store = memStore([{ key: 'd1', attrs: { type: 'kyc' } }]);
  const cert = issueCert(store, claim);
  assert.equal(cert.conclusion, 'fail');
  assert.deepEqual(checkCert(store, cert).ok, true);
});
