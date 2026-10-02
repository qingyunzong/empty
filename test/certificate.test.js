'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settle = require('../lib/settle');
const { makeTmpDir, writeJson, runCli } = require('./helpers');

// Two symmetric obligations; the daily cap forbids settling both, so the
// optimum is tied between {o1} and {o2}.
const OBLIGATIONS = {
  obligations: [
    { id: 'o1', from: 'A', to: 'B', amount: 100, days: 1, status: 'confirmed' },
    { id: 'o2', from: 'C', to: 'D', amount: 100, days: 1, status: 'confirmed' },
  ],
};

const CONSTRAINTS = {
  fee_bps: 10,
  fixed_fee: 5,
  freeze_bps: 10,
  max_total_fee: 1000,
  max_days: 5,
  max_total_freeze: 1000,
  max_daily_amount: 150,
};

test('tied optima are fully enumerated and the certificate hashes the full candidate set', () => {
  const obligations = settle.normalizeObligations(OBLIGATIONS);
  const constraints = settle.normalizeConstraints(CONSTRAINTS);
  const result = settle.optimize(obligations, constraints);
  assert.equal(result.ok, true);
  const cert = result.plan.certificate;
  assert.equal(cert.tiedCount, 2);
  assert.deepEqual(cert.tiedKeys, ['A>B:100#o1', 'C>D:100#o2']);
  // Fixed key order selects the lexicographically smallest key.
  assert.equal(cert.chosenKey, 'A>B:100#o1');
  assert.equal(result.plan.obligations.join(','), 'o1');
  // The certificate hash commits to the complete tied candidate set.
  const expectedHash = settle.sha256hex(settle.canonicalize(['A>B:100#o1', 'C>D:100#o2']));
  assert.equal(cert.candidateSetHash, expectedHash);
  // Elimination record explains the tied loser.
  const loser = result.eliminated.find((e) => e.key === 'C>D:100#o2');
  assert.ok(loser);
  assert.match(loser.reason, /tied optimal; not selected by fixed key order/);
});

test('certificate in the emitted plan file matches a recomputed candidate set hash', () => {
  const dir = makeTmpDir();
  writeJson(path.join(dir, 'obligations.json'), OBLIGATIONS);
  writeJson(path.join(dir, 'constraints.json'), CONSTRAINTS);
  const res = runCli(['optimize'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const recomputed = settle.sha256hex(settle.canonicalize(plan.certificate.tiedKeys));
  assert.equal(plan.certificate.candidateSetHash, recomputed);
  assert.equal(plan.certificate.tiedCount, plan.certificate.tiedKeys.length);
});
