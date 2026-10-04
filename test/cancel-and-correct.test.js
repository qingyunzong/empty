'use strict';
// Acceptance: cancelling a receipt releases the internal row and preserves the
// historical match; amount correction re-locates the diff cluster.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('cancel releases internal row and keeps match history', () => {
  const engine = new Engine();
  engine.apply({ type: 'internal', id: 'I1', amount: 77.25, date: '2026-03-01' });
  engine.apply({ type: 'external', id: 'E1', amount: 77.25, date: '2026-03-01' });
  assert.equal(engine.snapshot().clusters.length, 0, 'matched pair settles');

  engine.apply({ type: 'cancel', id: 'E1' });
  const snap = engine.snapshot();
  assert.equal(snap.clusters.length, 1);
  const cluster = snap.clusters[0];
  assert.deepEqual(cluster.members, ['I1'], 'cancelled receipt leaves the graph');
  assert.equal(cluster.status, 'UNRESOLVED');
  assert.equal(cluster.unresolved[0].reason, 'no_candidate');
  assert.ok(cluster.explanations.some((x) => x.includes('released') && x.includes('cancel')));
  assert.ok(snap.suggestions.some((s) => s.action === 'upload_receipt' && s.target === 'I1'));

  const hist = engine.history.map((h) => `${h.event}:${h.internalId}<->${h.externalId}:${h.reason}`);
  assert.deepEqual(hist, ['matched:I1<->E1:upsert', 'released:I1<->E1:cancel'], 'historical match preserved');
});

test('amount correction breaks the match and re-locates the diff cluster', () => {
  const engine = new Engine();
  engine.apply({ type: 'internal', id: 'I1', amount: 500, date: '2026-03-05' });
  engine.apply({ type: 'external', id: 'E1', amount: 500, date: '2026-03-05' });
  assert.equal(engine.snapshot().clusters.length, 0);

  // Correction outside the v1 exact rule breaks the match and releases both rows.
  engine.apply({ type: 'external', id: 'E1', amount: 500.6, date: '2026-03-05' });
  const broken = engine.snapshot();
  assert.equal(broken.clusters.length, 2, 'both rows become singleton diff clusters');
  assert.ok(engine.history.some((h) => h.event === 'released' && h.reason === 'correction'));

  // Switching to the tolerant rule re-matches them with an amount diff.
  engine.apply({ type: 'rule', version: 'v2' });
  const snap = engine.snapshot();
  assert.equal(snap.clusters.length, 1);
  const cluster = snap.clusters[0];
  assert.equal(cluster.status, 'UNRESOLVED', 'amount drift keeps cluster unresolved');
  assert.equal(cluster.matches[0].amountDiffCents, 60);
  const fix = snap.suggestions.find((s) => s.action === 'amount_correction');
  assert.equal(fix.deltaCents, 60);
  assert.equal(fix.target, 'E1');
});
