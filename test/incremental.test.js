'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MaintenanceStore } = require('../src/index.js');

function baseProblem() {
  return {
    budget: 200,
    crews: 2,
    parts: { pump: 1 },
    tasks: [
      { id: 'root', downtime: 5, deferPenalty: 30, modes: [{ id: 'fast', duration: 2, cost: 90, parts: { pump: 1 } }, { id: 'slow', duration: 5, cost: 20 }] },
      { id: 'mid', deps: ['root'], downtime: 3, deferPenalty: 20, modes: [{ id: 'fast', duration: 2, cost: 60 }, { id: 'slow', duration: 4, cost: 15 }] },
      { id: 'leaf', deps: ['mid'], downtime: 2, deferPenalty: 15, modes: [{ id: 'fast', duration: 1, cost: 40 }, { id: 'slow', duration: 3, cost: 10 }] },
    ],
  };
}

test('budget cut triggers plan change and successor invalidation', () => {
  const store = new MaintenanceStore(baseProblem());
  const before = store.currentResult();
  assert.equal(before.tasks.root.state, 'scheduled');
  assert.equal(before.tasks.mid.state, 'scheduled');
  assert.equal(before.tasks.leaf.state, 'scheduled');

  const step = store.applyCommand({ type: 'setBudget', budget: 30 });
  assert.equal(step.status, 'ok');
  const after = step.result;
  // Only the cheap modes fit; the plan must change.
  assert.ok(after.objective.cost <= 30);
  assert.notDeepEqual(after.tasks, before.tasks);
  // Diff reports the objective movement.
  assert.equal(step.diff.downtime.from, before.objective.downtime);
  assert.equal(step.diff.downtime.to, after.objective.downtime);
  assert.ok(step.diff.changes.length > 0);

  // Slash the budget to almost nothing: root becomes unaffordable and the
  // deferral propagates to mid and leaf (successor invalid to invalid state).
  const step2 = store.applyCommand({ type: 'setBudget', budget: 5 });
  assert.equal(step2.result.tasks.root.state, 'deferred');
  assert.equal(step2.result.tasks.mid.state, 'deferred');
  assert.equal(step2.result.tasks.mid.reason, 'predecessor-deferred');
  assert.equal(step2.result.tasks.leaf.state, 'deferred');
  assert.equal(step2.result.tasks.leaf.reason, 'predecessor-deferred');
  // mid and leaf were already deferred at budget 30; the newly deferred
  // task is root, and its deferral keeps the successors invalidated.
  const deferredChanges = step2.diff.changes.filter((c) => c.type === 'deferred').map((c) => c.task);
  assert.ok(deferredChanges.includes('root'));
});

test('undo and redo restore exact previous states', () => {
  const store = new MaintenanceStore(baseProblem());
  const r0 = store.currentResult();
  store.applyCommand({ type: 'setBudget', budget: 30 });
  const r1 = store.currentResult();
  store.applyCommand({ type: 'updateModeCost', taskId: 'mid', modeId: 'fast', cost: 5 });
  const r2 = store.currentResult();

  const u1 = store.applyCommand({ type: 'undo' });
  assert.deepEqual(store.currentResult(), r1);
  assert.equal(u1.diff.downtime.to, r1.objective.downtime);
  store.applyCommand({ type: 'undo' });
  assert.deepEqual(store.currentResult(), r0);

  store.applyCommand({ type: 'redo' });
  assert.deepEqual(store.currentResult(), r1);
  store.applyCommand({ type: 'redo' });
  assert.deepEqual(store.currentResult(), r2);

  // A new command clears the redo stack.
  store.applyCommand({ type: 'undo' });
  store.applyCommand({ type: 'setBudget', budget: 500 });
  assert.throws(
    () => store.applyCommand({ type: 'redo' }),
    (err) => err.code === 'NOTHING_TO_REDO',
  );
});

test('mode price change re-optimizes mode selection', () => {
  const store = new MaintenanceStore(baseProblem());
  const before = store.currentResult();
  const step = store.applyCommand({ type: 'updateModeCost', taskId: 'root', modeId: 'fast', cost: 500 });
  const after = step.result;
  assert.ok(after.objective.cost <= 200);
  if (before.tasks.root.mode === 'fast') {
    assert.notEqual(after.tasks.root.mode, 'fast');
    assert.ok(step.diff.changes.some((c) => c.task === 'root' && c.type === 'mode-changed'));
  }
});

test('addTask and removeTask are supported incrementally', () => {
  const store = new MaintenanceStore(baseProblem());
  const add = store.applyCommand({
    type: 'addTask',
    task: { id: 'extra', deps: ['leaf'], downtime: 1, modes: [{ id: 'm', duration: 2, cost: 5 }] },
  });
  assert.equal(add.result.tasks.extra.state, 'scheduled');
  assert.ok(add.diff.changes.some((c) => c.task === 'extra' && c.type === 'added'));

  const remove = store.applyCommand({ type: 'removeTask', taskId: 'extra' });
  assert.ok(!('extra' in remove.result.tasks));
  assert.ok(remove.diff.changes.some((c) => c.task === 'extra' && c.type === 'removed'));

  // removeTask strips dangling dependency edges.
  const rm = store.applyCommand({ type: 'removeTask', taskId: 'mid' });
  assert.equal(rm.result.tasks.leaf.state, 'scheduled');
});

test('results are memoized: undo/redo revisit is cache-hit consistent', () => {
  const store = new MaintenanceStore(baseProblem());
  const a = store.currentResult();
  store.applyCommand({ type: 'setBudget', budget: 30 });
  store.applyCommand({ type: 'undo' });
  const b = store.currentResult();
  assert.deepEqual(a, b);
  assert.equal(store.resultCache.size >= 1, true);
});
