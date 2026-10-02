'use strict';

// Acceptance 4: tied optima are fully enumerated and the certificate carries
// the hash of the complete candidate set; selection follows the fixed key order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { makeCase, runCli, statePath } = require('./helpers');

// Independent canonical JSON + hash, re-implemented here on purpose.
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value) {
  return crypto.createHash('sha256').update(canon(value), 'utf8').digest('hex');
}

const tieObligations = [
  { id: 'o1', from: 'A', to: 'B', amount: 100, day: 0, status: 'confirmed' },
  { id: 'o2', from: 'B', to: 'A', amount: 100, day: 0, status: 'confirmed' },
  { id: 'o3', from: 'A', to: 'B', amount: 100, day: 0, status: 'confirmed' },
];
const tieConstraints = {
  feeBps: 10,
  freezeBps: 0,
  freezeMarginBps: 0,
  timeBps: 0,
  maxFreeze: 100000,
  dailyLimit: 100000,
};

test('tied optima are fully enumerated and certificate hashes the complete candidate set', () => {
  const dir = makeCase(tieObligations, tieConstraints);
  const res = runCli(dir, 'optimize');
  assert.equal(res.status, 0, res.stderr);
  const record = JSON.parse(fs.readFileSync(statePath(dir, 'plan.json'), 'utf8'));
  const cert = record.certificate;
  assert.equal(record.tiedCount, 3);
  assert.equal(cert.tiedPlans.length, 3);
  const tiedKeys = cert.tiedPlans.map((p) => p.ids.join(','));
  assert.deepEqual(tiedKeys, ['o1,o2', 'o1,o2,o3', 'o2,o3']);
  assert.equal(cert.candidateSetHash, hash(cert.tiedPlans));
  assert.equal(cert.selectedKey, 'o1,o2', 'fixed key order picks lexicographically first');
  assert.deepEqual(record.selected.ids, ['o1', 'o2']);
  assert.equal(cert.optimalCost, 1000);
});

test('emit output embeds the same certificate with the candidate set hash', () => {
  const dir = makeCase(tieObligations, tieConstraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  const res = runCli(dir, 'emit');
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.certificate.tiedPlans.length, 3);
  assert.equal(out.certificate.candidateSetHash, hash(out.certificate.tiedPlans));
  assert.equal(out.executionMarker.candidateSetHash, out.certificate.candidateSetHash);
});

test('explain marks tied-but-not-selected plans explicitly', () => {
  const dir = makeCase(tieObligations, tieConstraints);
  assert.equal(runCli(dir, 'optimize').status, 0);
  const res = runCli(dir, 'explain');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /- \[o1,o2,o3\] tied optimal: not selected by fixed key order/);
  assert.match(res.stdout, /- \[o2,o3\] tied optimal: not selected by fixed key order/);
  assert.match(res.stdout, /- \[\] eliminated: dominated \(cost 3000 > optimal 1000\)/);
});
