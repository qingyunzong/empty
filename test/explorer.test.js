'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { interleavings, explore } = require('../src/explorer');

const TREE = {
  nodes: [
    { id: 'root', parent: null, capacity: 10 },
    { id: 'a', parent: 'root', capacity: 6 },
    { id: 'b', parent: 'root', capacity: 6 },
  ],
};

test('interleavings preserves per-actor order and enumerates in lexicographic order', () => {
  const actors = [
    { id: 'b', ops: [{ op: 'cancel', batchId: 'x' }, { op: 'settle', batchId: 'x' }] },
    { id: 'a', ops: [{ op: 'freeze', node: 'a' }] },
  ];
  const all = [...interleavings(actors)];
  const seqs = all.map((s) => s.map((step) => step.actor).join(''));
  assert.deepEqual(seqs, ['abb', 'bab', 'bba']);
  const sorted = [...seqs].sort();
  assert.deepEqual(seqs, sorted, 'generation order must be lexicographic by actor id');
  for (const s of all) {
    const bOps = s.filter((step) => step.actor === 'b').map((step) => step.index);
    assert.deepEqual(bOps, [0, 1], 'actor b order preserved');
  }
});

test('interleavings count matches the multinomial coefficient', () => {
  const actors = [
    { id: 'a', ops: [{ op: 'freeze', node: 'a' }, { op: 'unfreeze', node: 'a' }] },
    { id: 'b', ops: [{ op: 'freeze', node: 'b' }, { op: 'unfreeze', node: 'b' }] },
  ];
  assert.equal([...interleavings(actors)].length, 6);
});

test('safe scenario yields a certificate with counts and hash', () => {
  const actors = [
    {
      id: 'alice',
      ops: [
        { op: 'reserve', batchId: 'a1', items: [{ node: 'a', amount: 3 }] },
        { op: 'settle', batchId: 'a1' },
      ],
    },
    {
      id: 'bob',
      ops: [
        { op: 'reserve', batchId: 'b1', items: [{ node: 'b', amount: 4 }] },
        { op: 'cancel', batchId: 'b1' },
      ],
    },
  ];
  const result = explore(TREE, actors);
  assert.equal(result.safe, true);
  assert.equal(result.certificate.interleavings, 6);
  assert.equal(result.certificate.steps, 24);
  assert.match(result.certificate.hash, /^[0-9a-f]{64}$/);
  assert.ok(result.certificate.uniqueStates > 1);
});

test('counterexample is the lexicographically smallest failing prefix with chain and hash', () => {
  const actors = [
    { id: 'a', ops: [{ op: 'reserve', batchId: 'a1', items: [{ node: 'a', amount: 6 }], expect: 'ok' }] },
    { id: 'b', ops: [{ op: 'reserve', batchId: 'b1', items: [{ node: 'b', amount: 6 }], expect: 'ok' }] },
  ];
  const result = explore(TREE, actors);
  assert.equal(result.safe, false);
  const cx = result.counterexample;
  assert.equal(cx.failure.kind, 'unexpected_reject');
  assert.equal(cx.failure.code, 'INSUFFICIENT_BALANCE');
  assert.equal(cx.sequence.length, 2);
  assert.deepEqual(
    cx.sequence.map((s) => s.actor),
    ['a', 'b'],
    'lexicographically smallest counterexample starts with actor a then b',
  );
  assert.deepEqual(
    cx.ancestorChain.map((n) => n.id),
    ['root', 'b'],
  );
  assert.equal(cx.ancestorChain[0].held, 6, 'root still holds actor a reservation');
  assert.equal(cx.ancestorChain[1].held, 0, 'rejected reserve leaves no partial occupancy on b');
  assert.match(cx.stateHash, /^[0-9a-f]{64}$/);
});

test('expect:reject that succeeds is reported as a counterexample', () => {
  const actors = [
    { id: 'a', ops: [{ op: 'reserve', batchId: 'x', items: [{ node: 'a', amount: 1 }], expect: 'reject' }] },
  ];
  const result = explore(TREE, actors);
  assert.equal(result.safe, false);
  assert.equal(result.counterexample.failure.kind, 'unexpected_success');
  assert.equal(result.counterexample.sequence.length, 1);
});

test('over-reservation without expect stays safe because rejection is atomic', () => {
  const actors = [
    { id: 'a', ops: [{ op: 'reserve', batchId: 'big', items: [{ node: 'a', amount: 7 }] }] },
    { id: 'b', ops: [{ op: 'reserve', batchId: 'ok', items: [{ node: 'b', amount: 2 }] }] },
  ];
  const result = explore(TREE, actors);
  assert.equal(result.safe, true);
  assert.equal(result.certificate.interleavings, 2);
});
