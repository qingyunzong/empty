'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/core');
const { replay } = require('../src/history');

function run(ops) {
  const store = replay(ops);
  return store;
}

test('all / any / quorum basic satisfaction', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'A', op: 'addEvidence', id: 'e2', weight: 3 },
    { clock: 3, agentId: 'A', op: 'addEvidence', id: 'e3', weight: 1, active: false },
    { clock: 4, agentId: 'A', op: 'addClaim', id: 'cAll', type: 'all' },
    { clock: 5, agentId: 'A', op: 'addEdge', claim: 'cAll', ref: 'e1' },
    { clock: 6, agentId: 'A', op: 'addEdge', claim: 'cAll', ref: 'e2' },
    { clock: 7, agentId: 'A', op: 'addClaim', id: 'cAny', type: 'any' },
    { clock: 8, agentId: 'A', op: 'addEdge', claim: 'cAny', ref: 'e3' },
    { clock: 9, agentId: 'A', op: 'addEdge', claim: 'cAny', ref: 'e1' },
    { clock: 10, agentId: 'A', op: 'addClaim', id: 'cQ', type: 'quorum', threshold: 4 },
    { clock: 11, agentId: 'A', op: 'addEdge', claim: 'cQ', ref: 'e1' },
    { clock: 12, agentId: 'A', op: 'addEdge', claim: 'cQ', ref: 'e2' },
  ]);
  assert.equal(store.status.get('cAll').state, 'satisfied');
  assert.equal(store.status.get('cAny').state, 'satisfied'); // e1 active even though e3 retracted
  const q = store.status.get('cQ');
  assert.equal(q.state, 'satisfied');
  assert.equal(q.value, 5);
});

test('quorum shortfall reports have/need in reason chain', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'A', op: 'addClaim', id: 'cQ', type: 'quorum', threshold: 5 },
    { clock: 3, agentId: 'A', op: 'addEdge', claim: 'cQ', ref: 'e1' },
  ]);
  const q = store.status.get('cQ');
  assert.equal(q.state, 'unsatisfied');
  assert.deepEqual(q.reasons[0], { claim: 'cQ', rule: 'quorum', have: 2, need: 5 });
});

test('conflicting weights: last in (clock, agentId) total order wins', () => {
  // B@3 sorts before A@5, so A's weight=2 is last and wins.
  let store = run([
    { clock: 5, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 3, agentId: 'B', op: 'addEvidence', id: 'e1', weight: 3 },
  ]);
  assert.equal(store.evidence.get('e1').weight, 2);

  // Same clock: agentId breaks the tie, 'B' > 'A' so B wins.
  store = run([
    { clock: 4, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 7 },
    { clock: 4, agentId: 'B', op: 'setWeight', id: 'e1', weight: 9 },
  ]);
  assert.equal(store.evidence.get('e1').weight, 9);
});

test('duplicate addEdge of the same reference is idempotent', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 1 },
    { clock: 2, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 3, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 4, agentId: 'B', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 5, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
  ]);
  assert.deepEqual(store.claims.get('c1').refs, ['e1']);
});

test('retract/restore propagates invalidation along the dependency chain', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 1 },
    { clock: 2, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 3, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 4, agentId: 'A', op: 'addClaim', id: 'c2', type: 'all' },
    { clock: 5, agentId: 'A', op: 'addEdge', claim: 'c2', ref: 'c1' },
  ]);
  assert.equal(store.status.get('c2').state, 'satisfied');
  store.applyOp({ clock: 6, agentId: 'A', op: 'retract', id: 'e1' });
  store.settle();
  assert.equal(store.status.get('c1').state, 'unsatisfied');
  assert.equal(store.status.get('c2').state, 'unsatisfied');
  store.applyOp({ clock: 7, agentId: 'A', op: 'restore', id: 'e1' });
  store.settle();
  assert.equal(store.status.get('c2').state, 'satisfied');
});

test('incremental settle recomputes only the affected cone', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 1 },
    { clock: 2, agentId: 'A', op: 'addEvidence', id: 'e2', weight: 1 },
    { clock: 3, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 4, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 5, agentId: 'A', op: 'addClaim', id: 'c2', type: 'all' },
    { clock: 6, agentId: 'A', op: 'addEdge', claim: 'c2', ref: 'e2' },
    { clock: 7, agentId: 'A', op: 'addClaim', id: 'top', type: 'all' },
    { clock: 8, agentId: 'A', op: 'addEdge', claim: 'top', ref: 'c1' },
  ]);
  const before = store.stats.recomputed;
  store.applyOp({ clock: 9, agentId: 'A', op: 'retract', id: 'e1' });
  store.settle();
  // Only c1 and top are invalidated; c2 (unrelated branch) is untouched.
  assert.equal(store.stats.recomputed - before, 2);
  assert.equal(store.status.get('c2').state, 'satisfied');
  assert.equal(store.status.get('top').state, 'unsatisfied');
});

test('edge change (removeEdge) propagates and recomputes dependents', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 3 },
    { clock: 2, agentId: 'A', op: 'addClaim', id: 'c1', type: 'quorum', threshold: 3 },
    { clock: 3, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
  ]);
  assert.equal(store.status.get('c1').state, 'satisfied');
  store.applyOp({ clock: 4, agentId: 'A', op: 'removeEdge', claim: 'c1', ref: 'e1' });
  store.settle();
  const st = store.status.get('c1');
  assert.equal(st.state, 'unsatisfied');
  assert.equal(st.value, 0);
});

test('quorum with threshold 0 is satisfied with no references', () => {
  const store = run([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c0', type: 'quorum', threshold: 0 },
  ]);
  const st = store.status.get('c0');
  assert.equal(st.state, 'satisfied');
  assert.equal(st.value, 0);
});
