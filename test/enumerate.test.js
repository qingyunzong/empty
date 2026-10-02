'use strict';

// Acceptance 4: for labs with n <= 8 artifacts, cross-check the backtracking
// solver (pruned DFS) against naive enumeration of all simple standard chains.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lab } = require('../src/lab.js');
const { evaluate, explore } = require('../src/certify.js');
const { AT, rng } = require('../testkit/fixtures.js');

function randomLab(rand) {
  const lab = new Lab();
  const n = 2 + Math.floor(rand() * 7); // 2..8 artifacts (uut + standards)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const ranges = ['R1', 'R2'];
  const envs = ['E1', 'E2'];
  lab.addArtifact({ id: 'U', kind: 'uut', rangeClass: pick(ranges), envClass: pick(envs) });
  const standards = [];
  for (let i = 0; i < n - 1; i += 1) {
    const id = `S${i}`;
    standards.push(id);
    lab.addArtifact({
      id,
      kind: 'standard',
      root: rand() < 0.3,
      rangeClass: pick(ranges),
      envClass: pick(envs),
      uncertainty: Math.round((0.001 + rand() * 0.05) * 1e6) / 1e6,
      validFrom: '2025-01-01',
      validTo: rand() < 0.8 ? '2028-01-01' : '2026-01-01',
    });
  }
  const ids = ['U', ...standards];
  const linkCount = Math.floor(rand() * n * 1.5);
  for (let i = 0; i < linkCount; i += 1) {
    const from = ids[Math.floor(rand() * ids.length)];
    const to = standards[Math.floor(rand() * standards.length)];
    try {
      lab.link(from, to);
    } catch {
      // duplicate / self links are skipped for generation purposes
    }
  }
  lab.addArtifact({
    id: 'P',
    kind: 'point',
    uutId: 'U',
    rangeClass: pick(ranges),
    envClass: pick(envs),
    budget: Math.round((0.01 + rand() * 0.05) * 1e6) / 1e6,
    window: { tempMin: 18, tempMax: 26, humMin: 30, humMax: 60 },
  });
  if (rand() < 0.9) {
    lab.measure({
      pointId: 'P',
      value: 1,
      temp: 18 + rand() * 8,
      humidity: 30 + rand() * 30,
      uMeas: Math.round(rand() * 0.01 * 1e6) / 1e6,
      at: AT,
    });
  }
  if (rand() < 0.3 && standards.length > 0) {
    try {
      lab.reserve(pick(standards), 'job-x');
    } catch {
      // ignore
    }
  }
  return lab;
}

function sortedChains(chains) {
  return chains.map((c) => c.path.join('>')).sort();
}

test('acceptance 4: backtracking solver matches naive chain enumeration (n<=8)', () => {
  const counts = { CERT: 0, REFUTE: 0, INSUFFICIENT_EVIDENCE: 0, PENDING: 0 };
  for (let seed = 1; seed <= 400; seed += 1) {
    const lab = randomLab(rng(seed * 2654435761));
    const point = lab.state.artifacts.P;
    const uut = lab.state.artifacts.U;

    // 1. valid-chain sets must be identical
    const pruned = explore(lab.state, point, uut, AT, { prune: true });
    const naive = explore(lab.state, point, uut, AT, { prune: false });
    assert.deepEqual(sortedChains(pruned.chains), sortedChains(naive.chains), `chain mismatch at seed ${seed}`);

    // 2. final decisions must be identical
    const r1 = evaluate(lab, 'P', AT, { prune: true });
    const r2 = evaluate(lab, 'P', AT, { prune: false });
    assert.equal(r1.status, r2.status, `status mismatch at seed ${seed}`);
    counts[r1.status] += 1;
    if (r1.status === 'CERT') {
      assert.equal(r1.cert.hash, r2.cert.hash, `cert mismatch at seed ${seed}`);
      assert.equal(r1.cert.combinedUncertainty, r2.cert.combinedUncertainty);
    }
    if (r1.status === 'PENDING') {
      assert.equal(r1.reason, r2.reason, `pending reason mismatch at seed ${seed}`);
    }
  }
  // sanity: the random corpus must exercise every decision class
  assert.ok(counts.CERT > 0, JSON.stringify(counts));
  assert.ok(counts.REFUTE > 0, JSON.stringify(counts));
  assert.ok(counts.INSUFFICIENT_EVIDENCE > 0, JSON.stringify(counts));
  assert.ok(counts.PENDING > 0, JSON.stringify(counts));
});
