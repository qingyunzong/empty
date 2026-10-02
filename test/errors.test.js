import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-err-'));
}

function shopStore(dir) {
  const store = Store.init(dir);
  store.commit([
    { kind: 'setMachine', id: 'M1', machine: { id: 'M1', calendar: [[0, 1000]] } },
    { kind: 'setMachine', id: 'M2', machine: { id: 'M2', calendar: [[0, 1000]] } },
  ]);
  store.commit([
    { kind: 'setOrder', order: { id: 'W1', product: 'P1', priority: 2, ops: [{ machine: 'M1', duration: 50 }, { machine: 'M2', duration: 40 }] } },
    { kind: 'setOrder', order: { id: 'W2', product: 'P2', priority: 1, ops: [{ machine: 'M1', duration: 30 }] } },
  ]);
  return store;
}

test('E_BUDGET when best objective exceeds budget; no commit is written', () => {
  const dir = tmpdir();
  const store = shopStore(dir);
  const feasible = store.schedule();
  store.undo(); // remove schedule commit to keep state clean
  const seqBefore = store.status().seq;
  store.commit([{ kind: 'setBudget', budget: feasible.solution.objective - 1 }]);
  assert.throws(() => store.schedule(), (e) => e.code === 'E_BUDGET');
  assert.equal(store.status().seq, seqBefore + 1); // only the budget commit
  // Budget exactly at the optimum is accepted.
  store.commit([{ kind: 'setBudget', budget: feasible.solution.objective }]);
  assert.doesNotThrow(() => store.schedule());
});

test('E_PRECEDENCE when a dependency creates a cycle', () => {
  const dir = tmpdir();
  const store = shopStore(dir);
  // W1:1 -> W1:0 contradicts the intra-order chain W1:0 -> W1:1.
  assert.throws(
    () => store.commit([{ kind: 'addDep', op: 'W1:0', before: 'W1:1' }]),
    (e) => e.code === 'E_PRECEDENCE',
  );
  // Cross-order cycle: W1:0 before W2:0, then W2:0 before W1:0.
  store.commit([{ kind: 'addDep', op: 'W2:0', before: 'W1:0' }]);
  assert.throws(
    () => store.commit([{ kind: 'addDep', op: 'W1:0', before: 'W2:0' }]),
    (e) => e.code === 'E_PRECEDENCE',
  );
  // Failed commits leave the log untouched.
  assert.equal(store.records.filter((r) => r.kind === 'commit').length, 3);
});

test('E_PRECEDENCE from schedule when state already has a cycle', () => {
  const dir = tmpdir();
  const store = shopStore(dir);
  // Inject a cycle directly into committed state bypassing validation,
  // simulating a hand-edited journal: commit with skipPrecedenceCheck.
  store.commit([{ kind: 'addDep', op: 'W1:0', before: 'W1:1' }], { skipPrecedenceCheck: true });
  assert.throws(() => store.schedule(), (e) => e.code === 'E_PRECEDENCE');
});

test('schedule respects committed dependencies', () => {
  const dir = tmpdir();
  const store = shopStore(dir);
  store.commit([{ kind: 'addDep', op: 'W1:0', before: 'W2:0' }]); // W2 op before W1 op 0
  const { solution } = store.schedule();
  assert.ok(solution.assignments['W1:0'].start >= solution.assignments['W2:0'].end);
});
