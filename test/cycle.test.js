import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistories } from '../src/merge.js';
import { ConflictError } from '../src/errors.js';
import { CONFIG, lines } from './helpers.js';

// Two tablets, two sync rendezvous in crossed order:
//   A: a1  [sync m1]  a2  [sync m2]  a3
//   B: b1  [sync m2]  b2  [sync m1]  b3
// happens-before cycle: a2 -> sa2 -> b2 -> sb1 -> a2
const CROSSED = [
  {
    name: 'A',
    text: lines(
      { id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 1 },
      { id: 'sa1', device: 'A', ts: 2, op: 'sync', with: 'B', mark: 'm1' },
      { id: 'a2', device: 'A', ts: 3, op: 'set_count', plot: 'P1', species: 'S2', tier: 1 },
      { id: 'sa2', device: 'A', ts: 4, op: 'sync', with: 'B', mark: 'm2' },
      { id: 'a3', device: 'A', ts: 5, op: 'set_count', plot: 'P2', species: 'S1', tier: 1 }
    ),
  },
  {
    name: 'B',
    text: lines(
      { id: 'b1', device: 'B', ts: 1, op: 'set_count', plot: 'P2', species: 'S2', tier: 1 },
      { id: 'sb2', device: 'B', ts: 2, op: 'sync', with: 'A', mark: 'm2' },
      { id: 'b2', device: 'B', ts: 3, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 },
      { id: 'sb1', device: 'B', ts: 4, op: 'sync', with: 'A', mark: 'm1' },
      { id: 'b3', device: 'B', ts: 5, op: 'set_count', plot: 'P2', species: 'S1', tier: 2 }
    ),
  },
];

test('acceptance 2: crossed syncs yield the minimal causal cycle', () => {
  let err = null;
  try {
    mergeHistories(CONFIG, CROSSED);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConflictError, 'must report CONFLICT');
  assert.equal(err.detail.reason, 'causal_cycle');
  const { cycle } = err.detail;
  // minimal cycle: no shorter causal loop exists in this graph
  assert.equal(cycle.length, 4);
  assert.deepEqual([...cycle].sort(), ['a2', 'b2', 'sa2', 'sb1']);
  // consecutive edges must exist in happens-before (cycle is well-formed)
  const succ = {
    a2: 'sa2', sa2: 'b2', b2: 'sb1', sb1: 'a2',
  };
  for (let i = 0; i < cycle.length; i++) {
    const next = cycle[(i + 1) % cycle.length];
    assert.equal(succ[cycle[i]], next, `edge ${cycle[i]} -> ${next}`);
  }
});

test('interfering concurrent writes are a CONFLICT even without a cycle', () => {
  const inputs = [
    { name: 'A', text: lines({ id: 'a1', device: 'A', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 2 }) },
    { name: 'B', text: lines({ id: 'b1', device: 'B', ts: 1, op: 'set_count', plot: 'P1', species: 'S1', tier: 3 }) },
  ];
  assert.throws(
    () => mergeHistories(CONFIG, inputs),
    (e) => e instanceof ConflictError && e.detail.reason === 'concurrent_writes'
  );
});
