'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { ts } = require('../test-support/helpers');

test('one-to-many is rejected under v1 as UNRESOLVED, never unsatisfiable', () => {
  const engine = new Engine({ rulesVersion: 'v1' });
  engine.apply({ type: 'internal', id: 'I1', amount: 60, ts: ts(10) });
  engine.apply({ type: 'internal', id: 'I2', amount: 40, ts: ts(10) });
  engine.apply({ type: 'external', id: 'E1', amount: 100, ts: ts(10) });

  const clusters = engine.getDifferenceClusters();
  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  assert.equal(cluster.status, 'UNRESOLVED');
  for (const member of cluster.members) {
    assert.equal(member.state, 'UNRESOLVED');
    assert.equal(member.reason, 'ONE_TO_MANY_REJECTED');
    // pending-manual items must never surface as an unsatisfiable/error state
    assert.ok(!/UNSAT|ERROR|IMPOSSIBLE/i.test(member.state));
  }
  const manual = cluster.suggestions.filter((s) => s.action === 'MANUAL_REVIEW');
  assert.equal(manual.length, 3);
  for (const s of manual) assert.equal(s.reason, 'ONE_TO_MANY_REJECTED');
});

test('conflict losers are UNRESOLVED with MATCH_CONFLICT, total order picks winner', () => {
  const engine = new Engine({ rulesVersion: 'v1' });
  // E1(100) is a candidate for both I1(100, t+0h) and I2(100, t+2h).
  // Total order: amount diff tie, time diff 0h < 2h -> I1 wins deterministically.
  engine.apply({ type: 'internal', id: 'I2', amount: 100, ts: ts(12) });
  engine.apply({ type: 'external', id: 'E1', amount: 100, ts: ts(10) });
  engine.apply({ type: 'internal', id: 'I1', amount: 100, ts: ts(10) });

  const clusters = engine.getAllClusters();
  assert.equal(clusters.length, 1);
  const states = new Map(clusters[0].members.map((m) => [m.key, m.state]));
  assert.equal(states.get('I:I1'), 'MATCHED');
  assert.equal(states.get('E:E1'), 'MATCHED');
  assert.equal(states.get('I:I2'), 'UNRESOLVED');
  const loser = clusters[0].members.find((m) => m.key === 'I:I2');
  assert.equal(loser.reason, 'MATCH_CONFLICT');
});
