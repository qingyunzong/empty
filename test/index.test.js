import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../src/store.js';
import { Planner } from '../src/planner.js';

function makeStore(specs) {
  const store = new JobStore();
  for (const s of specs) store.add(s);
  return store;
}

test('inverted-index candidates equal full linear-scan results', () => {
  const store = makeStore([
    { id: 'A', description: '低温 固化 M-1 EQ-1', material: 'M-1', equipment: 'EQ-1', cost: 1, overdue: 0 },
    { id: 'B', description: '低温 固化 M-2 x x x x x x x EQ-2', material: 'M-2', equipment: 'EQ-2', cost: 1, overdue: 0 }, // distance 7 -> scan rejects
    { id: 'C', description: '高温 固化 M-3 EQ-3', material: 'M-3', equipment: 'EQ-3', cost: 1, overdue: 0 }, // no phrase
    { id: 'D', description: '低温 固化 M-4 EQ-4 低温 固化', material: 'M-4', equipment: 'EQ-4', cost: 1, overdue: 0 },
    { id: 'E', description: '低温 固化 M-5', material: 'M-5', equipment: 'EQ-5', cost: 1, overdue: 0 }, // missing equipment
  ]);
  const planner = new Planner(store);
  const fromIndex = planner.candidates().map((c) => c.job.id).sort();
  // independent expectation: only A and D match by scan semantics
  assert.deepEqual(fromIndex, ['A', 'D']);
});

test('voided jobs are filtered from candidates immediately', () => {
  const store = makeStore([
    { id: 'A', description: '低温 固化 M-1 EQ-1', material: 'M-1', equipment: 'EQ-1', cost: 1, overdue: 0 },
  ]);
  store.void('A');
  const planner = new Planner(store);
  assert.equal(planner.candidates().length, 0);
  // audit retained
  assert.deepEqual(store.audit.map((a) => a.op), ['add', 'void']);
  assert.equal(store.jobs.get('A').voided, true);
});
