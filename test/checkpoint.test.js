import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initState, solveState, pin, forkCheckpoint, restoreCheckpoint, mergeCheckpoint,
} from '../src/state.js';

function sampleInstance() {
  return {
    machines: 2,
    memoryLimit: 4,
    steps: [
      { id: 'a', params: ['x', 'y'], memory: 1, duration: 2 },
      { id: 'b', params: ['u', 'v'], memory: 2, duration: 1 },
      { id: 'c', params: ['p'], memory: 1, duration: 1 },
    ],
    edges: [['a', 'b']],
    compat: [{ between: ['a', 'b'], allow: [['x', 'u'], ['y', 'v'], ['y', 'u']] }],
  };
}

test('acceptance 3: merge of prefix-consistent chains succeeds', () => {
  const state = initState(sampleInstance());
  solveState(state);
  forkCheckpoint(state, 'cp1');
  pin(state, 'a', 'x');
  const result = mergeCheckpoint(state, 'cp1');
  assert.equal(result.status, 'MERGED');
  assert.equal(result.height, state.chain.length);
});

test('acceptance 3: diverged histories return CONFLICT with earliest divergent edge', () => {
  const state = initState(sampleInstance());
  solveState(state);
  const baseHeight = state.chain.length;
  forkCheckpoint(state, 'cp1');
  // Current branch: pin a=x.
  pin(state, 'a', 'x');
  forkCheckpoint(state, 'branchA');
  // Other branch: restore to cp1, pin a=y instead.
  restoreCheckpoint(state, 'cp1');
  pin(state, 'a', 'y');
  // Current chain and branchA share a prefix of baseHeight entries, then diverge.
  let conflict = null;
  try {
    mergeCheckpoint(state, 'branchA');
  } catch (err) {
    conflict = err;
  }
  assert.ok(conflict, 'expected CONFLICT');
  assert.equal(conflict.status, 'CONFLICT');
  const div = conflict.details.divergence;
  assert.equal(div.index, baseHeight, 'divergence must be at the earliest fork edge');
  assert.equal(div.edge.from, state.chain[baseHeight - 1].hash);
  assert.notEqual(div.edge.current.hash, div.edge.checkpoint.hash);
  // The divergent entries are the two different pin operations.
  assert.equal(div.edge.current.entry.type, 'pin');
  assert.equal(div.edge.checkpoint.entry.type, 'pin');
  assert.notEqual(div.edge.current.entry.param, div.edge.checkpoint.entry.param);
});

test('acceptance 3: checkpoint restore then merge is a no-op fast-forward', () => {
  const state = initState(sampleInstance());
  solveState(state);
  forkCheckpoint(state, 'cp1');
  pin(state, 'a', 'x');
  forkCheckpoint(state, 'cp2');
  restoreCheckpoint(state, 'cp1');
  // cp2 chain extends current chain: merge adopts the longer chain.
  const result = mergeCheckpoint(state, 'cp2');
  assert.equal(result.status, 'MERGED');
  assert.equal(state.chain[state.chain.length - 1].entry.type, 'done');
});

test('checkpoint errors are INVALID_INPUT', () => {
  const state = initState(sampleInstance());
  assert.throws(() => forkCheckpoint(state, ''), /non-empty/);
  forkCheckpoint(state, 'cp');
  assert.throws(() => forkCheckpoint(state, 'cp'), /already exists/);
  assert.throws(() => restoreCheckpoint(state, 'nope'), /unknown checkpoint/);
  assert.throws(() => mergeCheckpoint(state, 'nope'), /unknown checkpoint/);
});
