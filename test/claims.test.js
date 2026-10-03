import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function engineWith(ops) {
  const e = new Engine();
  ops.forEach((op, i) => e.apply({ clock: i + 1, agentId: 'tester', ...op }));
  return e;
}

test('all: empty refs vacuously true, inactive evidence falsifies', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'c', type: 'all' },
    { op: 'addEvidence', id: 'e1', weight: 1 },
    { op: 'addEdge', claim: 'c', ref: 'e1' },
  ]);
  assert.equal(e.statusOf('c').satisfied, true);
  e.apply({ clock: 4, agentId: 'tester', op: 'retractEvidence', id: 'e1' });
  assert.deepEqual(e.statusOf('c'), { satisfied: false, error: null });
});

test('any: empty refs false, single active evidence satisfies', () => {
  const e = engineWith([{ op: 'defineClaim', id: 'c', type: 'any' }]);
  assert.equal(e.statusOf('c').satisfied, false);
  e.apply({ clock: 2, agentId: 'tester', op: 'addEvidence', id: 'e1', weight: 1 });
  e.apply({ clock: 3, agentId: 'tester', op: 'addEdge', claim: 'c', ref: 'e1' });
  assert.equal(e.statusOf('c').satisfied, true);
});

test('quorum: sums weights of satisfied refs against threshold', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'q', type: 'quorum', threshold: 5 },
    { op: 'addEvidence', id: 'a', weight: 2 },
    { op: 'addEvidence', id: 'b', weight: 3 },
    { op: 'addEdge', claim: 'q', ref: 'a' },
    { op: 'addEdge', claim: 'q', ref: 'b' },
  ]);
  assert.equal(e.statusOf('q').satisfied, true);
  e.apply({ clock: 6, agentId: 'tester', op: 'retractEvidence', id: 'b' });
  assert.equal(e.statusOf('q').satisfied, false);
  e.apply({ clock: 7, agentId: 'tester', op: 'addEvidence', id: 'a', weight: 5 });
  assert.equal(e.statusOf('q').satisfied, true);
});

test('quorum: threshold 0 is satisfied with no references', () => {
  const e = engineWith([{ op: 'defineClaim', id: 'q', type: 'quorum', threshold: 0 }]);
  assert.deepEqual(e.statusOf('q'), { satisfied: true, error: null });
});

test('claims can reference claims; claim weight defaults to 1', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'leaf', type: 'all' },
    { op: 'addEvidence', id: 'e1', weight: 4 },
    { op: 'addEdge', claim: 'leaf', ref: 'e1' },
    { op: 'defineClaim', id: 'mid', type: 'any' },
    { op: 'addEdge', claim: 'mid', ref: 'leaf' },
    { op: 'defineClaim', id: 'top', type: 'quorum', threshold: 2 },
    { op: 'addEdge', claim: 'top', ref: 'mid' },
    { op: 'addEdge', claim: 'top', ref: 'leaf' },
  ]);
  assert.equal(e.statusOf('top').satisfied, true); // 1 + 1 >= 2
  e.apply({ clock: 9, agentId: 'tester', op: 'retractEvidence', id: 'e1' });
  assert.equal(e.statusOf('top').satisfied, false); // 0 + 0
});

test('defineClaim weight is used when referenced by a quorum', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'heavy', type: 'all', weight: 3 },
    { op: 'addEvidence', id: 'e1', weight: 1 },
    { op: 'addEdge', claim: 'heavy', ref: 'e1' },
    { op: 'defineClaim', id: 'q', type: 'quorum', threshold: 3 },
    { op: 'addEdge', claim: 'q', ref: 'heavy' },
  ]);
  assert.equal(e.statusOf('q').satisfied, true);
});

test('repeated addEdge of the same reference is idempotent', () => {
  const ops = [
    { op: 'defineClaim', id: 'c', type: 'quorum', threshold: 2 },
    { op: 'addEvidence', id: 'e1', weight: 1 },
    { op: 'addEdge', claim: 'c', ref: 'e1' },
  ];
  const once = engineWith(ops);
  const twice = engineWith([...ops, { op: 'addEdge', claim: 'c', ref: 'e1' }]);
  assert.equal(once.stateHash(), twice.stateHash());
  // quorum threshold 2 with a single weight-1 ref: duplicate edge must not count twice
  assert.equal(twice.statusOf('c').satisfied, false);
});

test('removeEdge updates satisfaction and is idempotent', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'c', type: 'any' },
    { op: 'addEvidence', id: 'e1', weight: 1 },
    { op: 'addEdge', claim: 'c', ref: 'e1' },
  ]);
  assert.equal(e.statusOf('c').satisfied, true);
  e.apply({ clock: 4, agentId: 'tester', op: 'removeEdge', claim: 'c', ref: 'e1' });
  assert.equal(e.statusOf('c').satisfied, false);
  const h1 = e.stateHash();
  e.apply({ clock: 5, agentId: 'tester', op: 'removeEdge', claim: 'c', ref: 'e1' });
  assert.equal(e.stateHash(), h1);
});

test('redefining a claim preserves refs and re-evaluates', () => {
  const e = engineWith([
    { op: 'defineClaim', id: 'c', type: 'all' },
    { op: 'addEvidence', id: 'e1', weight: 1 },
    { op: 'addEvidence', id: 'e2', weight: 1 },
    { op: 'addEdge', claim: 'c', ref: 'e1' },
    { op: 'addEdge', claim: 'c', ref: 'e2' },
    { op: 'retractEvidence', id: 'e2' },
  ]);
  assert.equal(e.statusOf('c').satisfied, false);
  e.apply({ clock: 7, agentId: 'tester', op: 'defineClaim', id: 'c', type: 'any' });
  assert.equal(e.statusOf('c').satisfied, true);
});

test('invalid ops are recorded deterministically in opErrors', () => {
  const e = engineWith([
    { op: 'addEdge', claim: 'ghost', ref: 'e1' },
    { op: 'frobnicate' },
    { op: 'addEvidence', id: 'e1' },
  ]);
  assert.equal(e.opErrors.length, 3);
  assert.equal(e.opErrors[0].reason, 'unknown claim "ghost"');
});
