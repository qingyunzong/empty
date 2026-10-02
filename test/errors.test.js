'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { replay } = require('../src/history');
const { snapshot, certificate } = require('../src/core');

test('cycle returns E_CYCLE for members and propagates to dependents', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 2, agentId: 'A', op: 'addClaim', id: 'c2', type: 'all' },
    { clock: 3, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'c2' },
    { clock: 4, agentId: 'A', op: 'addEdge', claim: 'c2', ref: 'c1' }, // closes the cycle
    { clock: 5, agentId: 'A', op: 'addClaim', id: 'top', type: 'any' },
    { clock: 6, agentId: 'A', op: 'addEdge', claim: 'top', ref: 'c1' },
  ]);
  assert.equal(store.status.get('c1').error.code, 'E_CYCLE');
  assert.equal(store.status.get('c2').error.code, 'E_CYCLE');
  const top = store.status.get('top');
  assert.equal(top.state, 'error');
  assert.equal(top.error.code, 'E_CYCLE');
  // rejection reason chain records the path from top down to the cycle
  assert.ok(top.reasons.some((r) => r.claim === 'top' && r.code === 'E_CYCLE' && r.via === 'c1'));
  assert.ok(top.reasons.some((r) => r.code === 'E_CYCLE'));
});

test('self-loop is E_CYCLE', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 2, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'c1' },
  ]);
  assert.equal(store.status.get('c1').error.code, 'E_CYCLE');
});

test('unknown reference returns E_REF and heals when the target appears', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 2, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'ghost' },
  ]);
  const st = store.status.get('c1');
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'E_REF');
  assert.ok(st.reasons.some((r) => r.code === 'E_REF' && r.ref === 'ghost'));

  store.applyOp({ clock: 3, agentId: 'A', op: 'addEvidence', id: 'ghost', weight: 1 });
  store.settle();
  assert.equal(store.status.get('c1').state, 'satisfied');
});

test('certificate for unknown claim is E_REF but still carries a state hash', () => {
  const store = replay([{ clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 1 }]);
  const cert = certificate(store, 'nope');
  assert.equal(cert.state, 'error');
  assert.equal(cert.error.code, 'E_REF');
  assert.equal(cert.support, null);
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
});

test('concurrent retract from two forks converges to one verifiable state', () => {
  const base = [
    { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'alice', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 3, agentId: 'alice', op: 'addEdge', claim: 'c1', ref: 'e1' },
  ];
  const forkA = [{ clock: 4, agentId: 'alice', op: 'retract', id: 'e1' }];
  const forkB = [{ clock: 4, agentId: 'bob', op: 'retract', id: 'e1' }];
  const s1 = snapshot(replay([...base, ...forkA, ...forkB]));
  const s2 = snapshot(replay([...base, ...forkB, ...forkA]));
  assert.equal(s1.claims.c1.state, 'unsatisfied');
  assert.equal(s1.evidence.e1.active, false);
  assert.equal(s1.stateHash, s2.stateHash); // order-independent, verifiable
});

test('quorum threshold 0 yields satisfied state with empty support certificate', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c0', type: 'quorum', threshold: 0 },
  ]);
  const cert = certificate(store, 'c0');
  assert.equal(cert.state, 'satisfied');
  assert.deepEqual(cert.support, []);
});

test('all error states remain hashable and reproducible', () => {
  const ops = [
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'cyc1', type: 'all' },
    { clock: 2, agentId: 'A', op: 'addEdge', claim: 'cyc1', ref: 'cyc1' },
    { clock: 3, agentId: 'B', op: 'addClaim', id: 'dangling', type: 'any' },
    { clock: 4, agentId: 'B', op: 'addEdge', claim: 'dangling', ref: 'missing' },
    { clock: 5, agentId: 'A', op: 'addClaim', id: 'zero', type: 'quorum', threshold: 0 },
  ];
  const h1 = snapshot(replay(ops)).stateHash;
  const h2 = snapshot(replay(ops.slice().reverse())).stateHash;
  assert.equal(h1, h2); // total order normalizes input permutation
});
