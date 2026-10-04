'use strict';
// Acceptance: rule version switch cascades through the topology, invalidation
// propagates to the whole cluster, recomputed cluster ids are stable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

test('rule switch cascades and invalidation propagates to the whole cluster', () => {
  const engine = new Engine();
  engine.apply({ type: 'internal', id: 'I1', amount: 100, date: '2026-01-10' });
  engine.apply({ type: 'internal', id: 'I2', amount: 100.5, date: '2026-01-11' });
  engine.apply({ type: 'external', id: 'E1', amount: 100, date: '2026-01-12' });

  const before = engine.snapshot();
  assert.equal(before.clusters.length, 3, 'v1 exact rule: three singleton diff clusters');
  assert.ok(before.clusters.every((c) => c.status === 'UNRESOLVED'));
  assert.ok(before.clusters.every((c) => c.unresolved[0].reason === 'no_candidate'));
  const beforeIds = before.clusters.map((c) => c.id);

  engine.apply({ type: 'rule', version: 'v2' });
  const after = engine.snapshot();

  assert.equal(after.clusters.length, 1, 'v2 window merges all three rows into one component');
  const cluster = after.clusters[0];
  assert.deepEqual(cluster.members, ['E1', 'I1', 'I2']);
  assert.ok(!beforeIds.includes(cluster.id), 'cluster id changes when topology changes');
  assert.deepEqual(cluster.matches.map((m) => [m.internal, m.external]), [['I1', 'E1']]);
  assert.deepEqual(cluster.unresolved, [{ side: 'internal', id: 'I2', reason: 'conflict_lost' }]);
  assert.equal(cluster.status, 'UNRESOLVED');

  // Deterministic recompute: replaying the same events yields identical ids.
  const replayed = new Engine();
  for (const event of [
    { type: 'internal', id: 'I1', amount: 100, date: '2026-01-10' },
    { type: 'internal', id: 'I2', amount: 100.5, date: '2026-01-11' },
    { type: 'external', id: 'E1', amount: 100, date: '2026-01-12' },
    { type: 'rule', version: 'v2' },
  ]) {
    replayed.apply(event);
  }
  assert.equal(replayed.snapshot().clusters[0].id, cluster.id, 'stable cluster id across recompute');

  // Switching back invalidates the match and restores singleton clusters.
  engine.apply({ type: 'rule', version: 'v1' });
  const reverted = engine.snapshot();
  assert.equal(reverted.clusters.length, 3);
  assert.deepEqual(
    reverted.clusters.map((c) => c.id).sort(),
    [...beforeIds].sort(),
    'reverting the rule restores the original stable cluster ids'
  );
  const releases = engine.history.filter((h) => h.event === 'released' && h.reason === 'rule_switch');
  assert.ok(releases.some((h) => h.internalId === 'I1' && h.externalId === 'E1'));
});
