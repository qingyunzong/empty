'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProblem, MaintenanceStore } = require('../src/index.js');

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected error code ${code}`);
}

test('cyclic DAG is rejected', () => {
  expectCode(() => validateProblem({
    budget: 10,
    tasks: [
      { id: 'A', deps: ['B'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'B', deps: ['A'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
    ],
  }), 'CYCLIC_DAG');
});

test('self dependency is rejected as a cycle', () => {
  expectCode(() => validateProblem({
    budget: 10,
    tasks: [{ id: 'A', deps: ['A'], modes: [{ id: 'm', duration: 1, cost: 1 }] }],
  }), 'CYCLIC_DAG');
});

test('three-node cycle is rejected', () => {
  expectCode(() => validateProblem({
    budget: 10,
    tasks: [
      { id: 'A', deps: ['C'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'B', deps: ['A'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'C', deps: ['B'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
    ],
  }), 'CYCLIC_DAG');
});

test('negative budget is rejected', () => {
  expectCode(() => validateProblem({ budget: -5, tasks: [] }), 'NEGATIVE_BUDGET');
});

test('unknown spare part is rejected', () => {
  expectCode(() => validateProblem({
    budget: 10,
    parts: { pump: 1 },
    tasks: [{ id: 'A', modes: [{ id: 'm', duration: 1, cost: 1, parts: { flux: 2 } }] }],
  }), 'UNKNOWN_PART');
});

test('unknown dependency is rejected', () => {
  expectCode(() => validateProblem({
    budget: 10,
    tasks: [{ id: 'A', deps: ['ghost'], modes: [{ id: 'm', duration: 1, cost: 1 }] }],
  }), 'UNKNOWN_DEPENDENCY');
});

test('duplicate task id is rejected', () => {
  expectCode(() => validateProblem({
    budget: 10,
    tasks: [
      { id: 'A', modes: [{ id: 'm', duration: 1, cost: 1 }] },
      { id: 'A', modes: [{ id: 'm', duration: 1, cost: 1 }] },
    ],
  }), 'DUPLICATE_TASK_ID');
});

test('invalid durations, costs and empty modes are rejected', () => {
  expectCode(() => validateProblem({
    budget: 10, tasks: [{ id: 'A', modes: [{ id: 'm', duration: 0, cost: 1 }] }],
  }), 'INVALID_DURATION');
  expectCode(() => validateProblem({
    budget: 10, tasks: [{ id: 'A', modes: [{ id: 'm', duration: 1, cost: -1 }] }],
  }), 'INVALID_COST');
  expectCode(() => validateProblem({
    budget: 10, tasks: [{ id: 'A', modes: [] }],
  }), 'INVALID_MODES');
});

test('commands introducing errors are rejected by the store', () => {
  const store = new MaintenanceStore({
    budget: 10,
    tasks: [{ id: 'A', modes: [{ id: 'm', duration: 1, cost: 1 }] }],
  });
  expectCode(() => store.applyCommand({ type: 'setBudget', budget: -1 }), 'NEGATIVE_BUDGET');
  expectCode(() => store.applyCommand({ type: 'nonsense' }), 'UNKNOWN_COMMAND');
  expectCode(() => store.applyCommand({ type: 'removeTask', taskId: 'ghost' }), 'UNKNOWN_TASK');
  expectCode(() => store.applyCommand({ type: 'updateModeCost', taskId: 'A', modeId: 'x', cost: 1 }), 'UNKNOWN_MODE');
  expectCode(() => store.applyCommand({
    type: 'addTask',
    task: { id: 'B', deps: ['C'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
  }), 'UNKNOWN_DEPENDENCY');
  expectCode(() => store.applyCommand({
    type: 'addTask',
    task: { id: 'B', deps: ['B'], modes: [{ id: 'm', duration: 1, cost: 1 }] },
  }), 'CYCLIC_DAG');
  expectCode(() => store.applyCommand({ type: 'undo' }), 'NOTHING_TO_UNDO');
  // Failed commands must not corrupt the current state.
  assert.equal(store.currentResult().objective.cost, 1);
});

test('undo/redo on empty stacks raise coded errors', () => {
  const store = new MaintenanceStore({ budget: 1, tasks: [] });
  expectCode(() => store.applyCommand({ type: 'undo' }), 'NOTHING_TO_UNDO');
  expectCode(() => store.applyCommand({ type: 'redo' }), 'NOTHING_TO_REDO');
});
