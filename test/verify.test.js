'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldEvents } = require('../src/state');
const { verify, COLD_CHAIN_LIMIT_MS } = require('../src/verify');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;

function chainEvents(prefix, { volume = 100, aliquotVolume = 40, reagent = 'R1', assayReagent } = {}) {
  return [
    { type: 'register', id: `${prefix}S`, kind: 'sample', volume, time: iso(T0) },
    { type: 'register', id: `${prefix}B`, kind: 'batch', reagent, time: iso(T0) },
    { type: 'aliquot', id: `${prefix}A`, parent: `${prefix}S`, volume: aliquotVolume, time: iso(T0 + 1 * H) },
    { type: 'assay', id: `${prefix}X`, parent: `${prefix}A`, batch: `${prefix}B`, reagent: assayReagent || reagent, conclusion: `conclusion-${prefix}`, time: iso(T0 + 2 * H) },
  ];
}

test('acceptance 1: revoking upstream invalidates downstream; attested independent branch preserved', () => {
  const events = [
    ...chainEvents('a'),
    ...chainEvents('b'),
    { type: 'attest', target: 'bX', signature: 'sig:auditor-1', time: iso(T0 + 3 * H) },
    { type: 'revoke', target: 'aS', reason: 'consent withdrawn', time: iso(T0 + 4 * H) },
  ];
  const { results, summary } = verify(foldEvents(events), { now: iso(T0 + 5 * H) });
  const a = results.find((r) => r.assay === 'aX');
  const b = results.find((r) => r.assay === 'bX');
  assert.equal(a.status, 'BROKEN');
  assert.match(a.reason, /revoked node aS/);
  assert.deepEqual(a.core.chain, ['aS', 'aA', 'aX']); // contagion path aS -> aA -> aX
  assert.equal(b.status, 'VALID'); // attested, does not depend on revoked node
  assert.equal(b.certificate.attested, true);
  assert.equal(summary.BROKEN, 1);
  assert.equal(summary.VALID, 1);
});

test('attestation does not rescue a conclusion that depends on a revoked node', () => {
  const events = [
    ...chainEvents('a'),
    { type: 'attest', target: 'aX', signature: 'sig:auditor-1', time: iso(T0 + 3 * H) },
    { type: 'revoke', target: 'aA', reason: 'mislabeled', time: iso(T0 + 4 * H) },
  ];
  const { results } = verify(foldEvents(events), { now: iso(T0 + 5 * H) });
  assert.equal(results[0].status, 'BROKEN');
});

test('acceptance 3: qc_fail propagates the minimal broken chain', () => {
  const events = [
    ...chainEvents('a'),
    { type: 'aliquot', id: 'aA2', parent: 'aA', volume: 10, time: iso(T0 + 2 * H) },
    { type: 'assay', id: 'aX2', parent: 'aA2', batch: 'aB', reagent: 'R1', conclusion: 'c2', time: iso(T0 + 3 * H) },
    { type: 'qc_fail', target: 'aA', time: iso(T0 + 4 * H) },
  ];
  const { results, summary } = verify(foldEvents(events), { now: iso(T0 + 5 * H) });
  const x1 = results.find((r) => r.assay === 'aX');
  const x2 = results.find((r) => r.assay === 'aX2');
  assert.equal(x1.status, 'BROKEN');
  assert.equal(x2.status, 'BROKEN');
  // Minimal broken chain: from the failed node down to the conclusion, nothing else.
  assert.deepEqual(x1.core.chain, ['aA', 'aX']);
  assert.deepEqual(x2.core.chain, ['aA', 'aA2', 'aX2']);
  assert.equal(summary.BROKEN, 2);
});

test('volume conservation violation breaks the chain', () => {
  const events = [
    { type: 'register', id: 'S', kind: 'sample', volume: 50, time: iso(T0) },
    { type: 'register', id: 'B', kind: 'batch', reagent: 'R1', time: iso(T0) },
    { type: 'aliquot', id: 'A1', parent: 'S', volume: 40, time: iso(T0 + H) },
    { type: 'aliquot', id: 'A2', parent: 'S', volume: 40, time: iso(T0 + H) }, // 80 > 50
    { type: 'assay', id: 'X', parent: 'A2', batch: 'B', reagent: 'R1', conclusion: 'c', time: iso(T0 + 2 * H) },
  ];
  const { results } = verify(foldEvents(events), { now: iso(T0 + 3 * H) });
  assert.equal(results[0].status, 'BROKEN');
  assert.match(results[0].reason, /VOLUME/);
});

test('reagent/batch incompatibility breaks the chain', () => {
  const events = [
    ...chainEvents('a', { assayReagent: 'R2' }), // batch aB only allows R1
  ];
  const { results } = verify(foldEvents(events), { now: iso(T0 + 3 * H) });
  assert.equal(results[0].status, 'BROKEN');
  assert.match(results[0].reason, /REAGENT/);
});

test('STALE when cold-chain limit exceeded; attested-while-fresh stays VALID', () => {
  const stale = verify(foldEvents(chainEvents('a')), { now: iso(T0 + 100 * H) });
  assert.equal(stale.results[0].status, 'STALE');

  const attested = verify(foldEvents([
    ...chainEvents('a'),
    { type: 'attest', target: 'aX', signature: 'sig:auditor-2', time: iso(T0 + 3 * H) },
  ]), { now: iso(T0 + 100 * H) });
  assert.equal(attested.results[0].status, 'VALID');

  const edgeGap = verify(foldEvents([
    { type: 'register', id: 'S', kind: 'sample', volume: 10, time: iso(T0) },
    { type: 'register', id: 'B', kind: 'batch', reagent: 'R1', time: iso(T0) },
    { type: 'aliquot', id: 'A', parent: 'S', volume: 5, time: iso(T0 + 80 * H) }, // gap > 72h
    { type: 'assay', id: 'X', parent: 'A', batch: 'B', reagent: 'R1', conclusion: 'c', time: iso(T0 + 81 * H) },
  ]), { now: iso(T0 + 82 * H) });
  assert.equal(edgeGap.results[0].status, 'STALE');
});

test('PENDING on budget exhaustion is not BROKEN', () => {
  const events = chainEvents('a');
  const { results, summary } = verify(foldEvents(events), { now: iso(T0 + 5 * H), budget: 1 });
  assert.equal(results[0].status, 'PENDING');
  assert.equal(summary.BROKEN, 0);
  assert.equal(summary.PENDING, 1);
  // With a sufficient budget the same log verifies VALID.
  const full = verify(foldEvents(events), { now: iso(T0 + 5 * H), budget: 10 });
  assert.equal(full.results[0].status, 'VALID');
});
