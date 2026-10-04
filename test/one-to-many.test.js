'use strict';
// Acceptance: one-to-many conflict is rejected by total order; the loser is
// UNRESOLVED with a reason, never treated as unsatisfiable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('one internal vs two identical receipts: id order wins, loser is UNRESOLVED', () => {
  const engine = new Engine();
  engine.apply({ type: 'internal', id: 'I1', amount: 42, date: '2026-02-01' });
  engine.apply({ type: 'external', id: 'E1', amount: 42, date: '2026-02-01' });
  engine.apply({ type: 'external', id: 'E2', amount: 42, date: '2026-02-01' });

  const snap = engine.snapshot();
  assert.equal(snap.clusters.length, 1);
  const cluster = snap.clusters[0];
  assert.deepEqual(cluster.matches.map((m) => [m.internal, m.external]), [['I1', 'E1']]);
  assert.deepEqual(cluster.unresolved, [{ side: 'external', id: 'E2', reason: 'conflict_lost' }]);
  assert.equal(cluster.status, 'UNRESOLVED', 'manual-review item must not be UNSAT/error');
  assert.ok(cluster.explanations.some((x) => x.includes('total order')));
  const review = snap.suggestions.find((s) => s.target === 'E2');
  assert.equal(review.action, 'manual_review');
});

test('conflict order: smaller amount diff beats id order', () => {
  const engine = new Engine();
  engine.apply({ type: 'rule', version: 'v2' });
  engine.apply({ type: 'internal', id: 'I1', amount: 100, date: '2026-02-01' });
  engine.apply({ type: 'external', id: 'E1', amount: 100.9, date: '2026-02-01' });
  engine.apply({ type: 'external', id: 'E2', amount: 100.1, date: '2026-02-02' });
  const cluster = engine.snapshot().clusters[0];
  assert.deepEqual(cluster.matches.map((m) => [m.internal, m.external]), [['I1', 'E2']]);
  assert.deepEqual(cluster.unresolved, [{ side: 'external', id: 'E1', reason: 'conflict_lost' }]);
});
