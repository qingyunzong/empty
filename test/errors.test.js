import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { totalOrder } from '../src/order.js';
import { certificate } from '../src/certificate.js';

// Acceptance 3: concurrent retraction, cycle formation, threshold 0 and
// unknown references all yield verifiable (deterministic, hashed) states.

test('concurrent retraction by two operators is deterministic', () => {
  const ops = [
    { clock: 1, agentId: 'alice', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'alice', op: 'defineClaim', id: 'c', type: 'all' },
    { clock: 3, agentId: 'alice', op: 'addEdge', claim: 'c', ref: 'e1' },
    { clock: 4, agentId: 'alice', op: 'retractEvidence', id: 'e1' },
    { clock: 4, agentId: 'bob', op: 'retractEvidence', id: 'e1' }, // same clock, concurrent
  ];
  const forward = new Engine().applyAll(totalOrder(ops));
  const reversed = new Engine().applyAll(totalOrder([...ops].reverse()));
  assert.equal(forward.stateHash(), reversed.stateHash());
  assert.deepEqual(forward.statusOf('c'), { satisfied: false, error: null });
  const ev = forward.snapshot().evidence.find((x) => x.id === 'e1');
  assert.equal(ev.active, false);
  // verifiable: replaying again reproduces the identical hash
  assert.equal(new Engine().applyAll(totalOrder(ops)).stateHash(), forward.stateHash());
});

test('self-loop and two-node cycle both yield E_CYCLE', () => {
  const e = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'defineClaim', id: 'x', type: 'all' },
    { clock: 2, agentId: 'a', op: 'addEdge', claim: 'x', ref: 'x' },
    { clock: 3, agentId: 'a', op: 'defineClaim', id: 'p', type: 'any' },
    { clock: 4, agentId: 'a', op: 'defineClaim', id: 'q', type: 'any' },
    { clock: 5, agentId: 'a', op: 'addEdge', claim: 'p', ref: 'q' },
    { clock: 6, agentId: 'a', op: 'addEdge', claim: 'q', ref: 'p' },
  ]);
  assert.equal(e.statusOf('x').error, 'E_CYCLE');
  assert.equal(e.statusOf('p').error, 'E_CYCLE');
  assert.equal(e.statusOf('q').error, 'E_CYCLE');
  assert.match(e.stateHash(), /^[0-9a-f]{64}$/);
});

test('cycle formed later propagates E_CYCLE to dependents; breaking it recovers', () => {
  const e = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'defineClaim', id: 'a1', type: 'all' },
    { clock: 2, agentId: 'a', op: 'defineClaim', id: 'a2', type: 'all' },
    { clock: 3, agentId: 'a', op: 'addEdge', claim: 'a1', ref: 'a2' },
    { clock: 4, agentId: 'a', op: 'defineClaim', id: 'top', type: 'any' },
    { clock: 5, agentId: 'a', op: 'addEdge', claim: 'top', ref: 'a1' },
  ]);
  assert.equal(e.statusOf('top').satisfied, true); // empty alls are true
  e.apply({ clock: 6, agentId: 'a', op: 'addEdge', claim: 'a2', ref: 'a1' }); // closes cycle
  assert.equal(e.statusOf('a1').error, 'E_CYCLE');
  assert.equal(e.statusOf('a2').error, 'E_CYCLE');
  assert.equal(e.statusOf('top').error, 'E_CYCLE'); // propagated upward
  e.apply({ clock: 7, agentId: 'a', op: 'removeEdge', claim: 'a2', ref: 'a1' }); // break cycle
  assert.deepEqual(e.statusOf('a1'), { satisfied: true, error: null });
  assert.deepEqual(e.statusOf('top'), { satisfied: true, error: null });
});

test('unknown reference yields E_REF and a verifiable certificate', () => {
  const e = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'defineClaim', id: 'c', type: 'any' },
    { clock: 2, agentId: 'a', op: 'addEdge', claim: 'c', ref: 'ghost' },
    { clock: 3, agentId: 'a', op: 'defineClaim', id: 'top', type: 'all' },
    { clock: 4, agentId: 'a', op: 'addEdge', claim: 'top', ref: 'c' },
  ]);
  assert.equal(e.statusOf('c').error, 'E_REF');
  assert.equal(e.statusOf('top').error, 'E_REF'); // propagates
  const cert = certificate(e, 'c');
  assert.equal(cert.error, 'E_REF');
  assert.equal(cert.reasons[0].code, 'E_REF');
  assert.ok(cert.reasons[0].children.some((ch) => ch.node === 'ghost' && ch.code === 'E_REF'));
  assert.equal(cert.stateHash, e.stateHash());
});

test('threshold 0 quorum certificate has an empty minimal support', () => {
  const e = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'defineClaim', id: 'q', type: 'quorum', threshold: 0 },
  ]);
  const cert = certificate(e, 'q');
  assert.equal(cert.satisfied, true);
  assert.deepEqual(cert.minimalSupport, []);
});

test('certificate for unknown claim id is E_REF', () => {
  const e = new Engine();
  const cert = certificate(e, 'nope');
  assert.equal(cert.error, 'E_REF');
  assert.equal(cert.satisfied, false);
});
