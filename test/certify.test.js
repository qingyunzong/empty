'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Lab } = require('../src/lab.js');
const { evaluate, labFromCore } = require('../src/certify.js');
const { hashObject } = require('../src/hash.js');
const { AT, baseLab } = require('../testkit/fixtures.js');

// A core must (a) still refute with one of the original violation types and
// (b) be deletion-minimal w.r.t. its traceability facts.
function assertMinimalCore(lab, pointId, result) {
  assert.equal(result.status, 'REFUTE');
  const core = result.core;
  const check = (c) => {
    const r = evaluate(labFromCore(lab, c), pointId, AT, { skipCore: true });
    return r.status === 'REFUTE' && r.violations.some((v) => core.violationTypes.includes(v.type));
  };
  assert.ok(check(core), 'core must still refute');
  const context = new Set([pointId, lab.state.artifacts[pointId].uutId]);
  for (const id of core.artifacts) {
    if (context.has(id)) continue;
    const smaller = { ...core, artifacts: core.artifacts.filter((x) => x !== id) };
    assert.ok(!check(smaller), `core not minimal: artifact ${id} is removable`);
  }
  for (const l of core.links) {
    const smaller = { ...core, links: core.links.filter((x) => !(x.from === l.from && x.to === l.to)) };
    assert.ok(!check(smaller), `core not minimal: link ${l.from}->${l.to} is removable`);
  }
}

test('CERT: valid chain, combined uncertainty, chain and hash in certificate', () => {
  const lab = baseLab();
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'CERT');
  const cert = r.cert;
  assert.deepEqual(cert.chain, ['ROOT', 'S1', 'U1']);
  const expected = Math.sqrt(0.005 ** 2 + 0.001 ** 2 + 0.002 ** 2);
  assert.ok(Math.abs(cert.combinedUncertainty - expected) < 1e-15);
  assert.equal(cert.budget, 0.02);
  assert.match(cert.id, /^CERT-[0-9a-f]{16}$/);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  const { id, hash, ...body } = cert;
  assert.equal(hashObject(body), hash);
  assert.equal(lab.state.certs[cert.id], cert);
});

test('acceptance 1: broken chain -> REFUTE with deletion-minimal core', () => {
  const lab = new Lab();
  lab.addArtifact({ id: 'S2', kind: 'standard', rangeClass: 'R1', envClass: 'E1', uncertainty: 0.001, validFrom: '2025-01-01', validTo: '2028-01-01' });
  lab.addArtifact({ id: 'S1', kind: 'standard', rangeClass: 'R1', envClass: 'E1', uncertainty: 0.005, validFrom: '2025-01-01', validTo: '2028-01-01' });
  lab.addArtifact({ id: 'U1', kind: 'uut', rangeClass: 'R1', envClass: 'E1' });
  lab.addArtifact({
    id: 'P1', kind: 'point', uutId: 'U1', rangeClass: 'R1', envClass: 'E1',
    budget: 0.02, window: { tempMin: 18, tempMax: 26, humMin: 30, humMax: 60 },
  });
  lab.link('U1', 'S1');
  lab.link('S1', 'S2'); // S2 is not a root and has no onward chain: broken
  lab.measure({ pointId: 'P1', value: 10, temp: 20, humidity: 40, uMeas: 0.001 });
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'BROKEN_CHAIN'));
  assertMinimalCore(lab, 'P1', r);
  // core keeps the broken tail: S1 (non-root terminal) and the link into it
  assert.ok(r.core.artifacts.includes('S1'));
  assert.ok(r.core.links.some((l) => l.from === 'U1' && l.to === 'S1'));
});

test('acceptance 2: missing environment window -> INSUFFICIENT_EVIDENCE, never REFUTE', () => {
  const lab = new Lab();
  lab.addArtifact({ id: 'ROOT', kind: 'standard', root: true, rangeClass: 'R1', envClass: 'E1', uncertainty: 0.001 });
  lab.addArtifact({ id: 'U1', kind: 'uut', rangeClass: 'R1', envClass: 'E1' });
  lab.addArtifact({ id: 'P1', kind: 'point', uutId: 'U1', rangeClass: 'R1', envClass: 'E1', budget: 0.02 });
  lab.link('U1', 'ROOT');
  lab.measure({ pointId: 'P1', value: 10, temp: 20, humidity: 40, uMeas: 0.001 });
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'INSUFFICIENT_EVIDENCE');
  assert.notEqual(r.status, 'REFUTE');
  assert.ok(r.missing.some((m) => m.type === 'NO_ENV_WINDOW'));
});

test('missing measurement and missing links -> INSUFFICIENT_EVIDENCE, never REFUTE', () => {
  const lab = baseLab();
  lab.state.measurements = [];
  const r1 = lab.certify('P1', AT);
  assert.equal(r1.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r1.missing.some((m) => m.type === 'NO_MEASUREMENT'));

  const lab2 = new Lab();
  lab2.addArtifact({ id: 'U1', kind: 'uut', rangeClass: 'R1', envClass: 'E1' });
  lab2.addArtifact({
    id: 'P1', kind: 'point', uutId: 'U1', rangeClass: 'R1', envClass: 'E1',
    budget: 0.02, window: { tempMin: 18, tempMax: 26, humMin: 30, humMax: 60 },
  });
  lab2.measure({ pointId: 'P1', value: 10, temp: 20, humidity: 40 });
  const r2 = lab2.certify('P1', AT);
  assert.equal(r2.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(r2.missing.some((m) => m.type === 'NO_TRACEABILITY_LINK'));
});

test('acceptance 3: budget boundary band -> PENDING, not REFUTE', () => {
  const lab = baseLab();
  lab.state.artifacts.S1.uncertainty = 0.019; // combined ~= 0.01913, band is [0.019, 0.021]
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.reason, 'BUDGET_BOUNDARY');
  assert.notEqual(r.status, 'REFUTE');
  assert.ok(r.combinedUncertainty >= 0.02 * 0.95 && r.combinedUncertainty <= 0.02 * 1.05);
});

test('budget clearly exceeded -> REFUTE with BUDGET_EXCEEDED core', () => {
  const lab = baseLab();
  lab.state.measurements[0].uMeas = 0.03; // combined ~= 0.0304 > 0.021
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'BUDGET_EXCEEDED'));
  assertMinimalCore(lab, 'P1', r);
});

test('env reading outside window -> REFUTE (ENV_OUT_OF_WINDOW)', () => {
  const lab = baseLab();
  lab.state.measurements[0].temp = 30;
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'ENV_OUT_OF_WINDOW'));
  assertMinimalCore(lab, 'P1', r);
});

test('expired standard -> REFUTE (EXPIRED)', () => {
  const lab = baseLab();
  lab.state.artifacts.S1.validTo = '2026-01-01';
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'EXPIRED'));
  assertMinimalCore(lab, 'P1', r);
});

test('uncertainty inversion (standard worse than required) -> REFUTE', () => {
  const lab = baseLab();
  lab.state.artifacts.S1.uncertainty = 0.05; // must be < budget 0.02
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'UNCERTAINTY_INVERSION'));
  assertMinimalCore(lab, 'P1', r);
});

test('cycle in traceability chain -> REFUTE (CYCLE)', () => {
  const lab = new Lab();
  lab.addArtifact({ id: 'S1', kind: 'standard', rangeClass: 'R1', envClass: 'E1', uncertainty: 0.005, validFrom: '2025-01-01', validTo: '2028-01-01' });
  lab.addArtifact({ id: 'S2', kind: 'standard', rangeClass: 'R1', envClass: 'E1', uncertainty: 0.003, validFrom: '2025-01-01', validTo: '2028-01-01' });
  lab.addArtifact({ id: 'U1', kind: 'uut', rangeClass: 'R1', envClass: 'E1' });
  lab.addArtifact({
    id: 'P1', kind: 'point', uutId: 'U1', rangeClass: 'R1', envClass: 'E1',
    budget: 0.02, window: { tempMin: 18, tempMax: 26, humMin: 30, humMax: 60 },
  });
  lab.link('U1', 'S1');
  lab.link('S1', 'S2');
  lab.link('S2', 'S1'); // cycle, no root reachable
  lab.measure({ pointId: 'P1', value: 10, temp: 20, humidity: 40, uMeas: 0.001 });
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'CYCLE'));
  assertMinimalCore(lab, 'P1', r);
});

test('domain mismatch (range class) -> REFUTE (RANGE_MISMATCH)', () => {
  const lab = baseLab();
  lab.state.artifacts.S1.rangeClass = 'R2';
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'REFUTE');
  assert.ok(r.violations.some((v) => v.type === 'RANGE_MISMATCH'));
});

test('leased standard blocks its chain -> PENDING (STANDARD_BUSY), freed after release', () => {
  const lab = baseLab();
  lab.reserve('S1', 'job-1');
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.reason, 'STANDARD_BUSY');
  assert.notEqual(r.status, 'REFUTE');
  assert.deepEqual(r.leased, ['S1']);
  lab.release('S1', 'job-1');
  const r2 = lab.certify('P1', AT);
  assert.equal(r2.status, 'CERT');
});

test('alternative free chain is used when another standard is leased', () => {
  const lab = baseLab();
  lab.addArtifact({ id: 'S2', kind: 'standard', rangeClass: 'R1', envClass: 'E1', grade: 'G1', uncertainty: 0.004, validFrom: '2025-01-01', validTo: '2028-01-01' });
  lab.link('U1', 'S2');
  lab.link('S2', 'ROOT');
  lab.reserve('S1', 'job-1');
  const r = lab.certify('P1', AT);
  assert.equal(r.status, 'CERT');
  assert.deepEqual(r.cert.chain, ['ROOT', 'S2', 'U1']);
});
