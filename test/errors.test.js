import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProblem, ProblemError } from '../src/model.js';
import { Scheduler } from '../src/scheduler.js';

test('cyclic DAG is rejected with the cycle in the message', () => {
  assert.throws(
    () =>
      validateProblem({
        budget: 10,
        tasks: [
          { id: 'A', deps: ['C'], modes: [{ duration: 1, cost: 1 }] },
          { id: 'B', deps: ['A'], modes: [{ duration: 1, cost: 1 }] },
          { id: 'C', deps: ['B'], modes: [{ duration: 1, cost: 1 }] },
        ],
      }),
    (err) => {
      assert.ok(err instanceof ProblemError);
      assert.equal(err.code, 'CYCLIC_DAG');
      assert.match(err.message, /cycle/);
      return true;
    },
  );
});

test('self-dependency is a cycle', () => {
  assert.throws(
    () =>
      validateProblem({
        budget: 10,
        tasks: [{ id: 'A', deps: ['A'], modes: [{ duration: 1, cost: 1 }] }],
      }),
    (err) => err.code === 'CYCLIC_DAG',
  );
});

test('negative budget is rejected', () => {
  assert.throws(
    () => validateProblem({ budget: -5, tasks: [] }),
    (err) => err.code === 'NEGATIVE_BUDGET',
  );
});

test('unknown spare part in a mode is rejected', () => {
  assert.throws(
    () =>
      validateProblem({
        budget: 10,
        parts: { valve: 1 },
        tasks: [{ id: 'A', modes: [{ duration: 1, cost: 1, parts: { gasket: 2 } }] }],
      }),
    (err) => {
      assert.equal(err.code, 'UNKNOWN_PART');
      assert.equal(err.details.part, 'gasket');
      return true;
    },
  );
});

test('unknown dependency and duplicate task ids are rejected', () => {
  assert.throws(
    () => validateProblem({ budget: 10, tasks: [{ id: 'A', deps: ['B'], modes: [{ duration: 1, cost: 1 }] }] }),
    (err) => err.code === 'UNKNOWN_DEPENDENCY',
  );
  assert.throws(
    () =>
      validateProblem({
        budget: 10,
        tasks: [
          { id: 'A', modes: [{ duration: 1, cost: 1 }] },
          { id: 'A', modes: [{ duration: 2, cost: 1 }] },
        ],
      }),
    (err) => err.code === 'DUPLICATE_TASK',
  );
});

test('command-level: addTask with self-cycle and setBudget negative are in-band errors', () => {
  const scheduler = new Scheduler({ budget: 10, tasks: [{ id: 'A', modes: [{ duration: 1, cost: 1 }] }] });
  scheduler.initialReport();
  const cyc = scheduler.applyCommand({ op: 'addTask', task: { id: 'B', deps: ['B'], modes: [{ duration: 1, cost: 1 }] } });
  assert.equal(cyc.status, 'error');
  assert.equal(cyc.error.code, 'CYCLIC_DAG');
  const neg = scheduler.applyCommand({ op: 'setBudget', budget: -1 });
  assert.equal(neg.status, 'error');
  assert.equal(neg.error.code, 'NEGATIVE_BUDGET');
  const dep = scheduler.applyCommand({ op: 'addTask', task: { id: 'C', deps: ['ZZ'], modes: [{ duration: 1, cost: 1 }] } });
  assert.equal(dep.error.code, 'UNKNOWN_DEPENDENCY');
});

test('schema violations are rejected', () => {
  assert.throws(() => validateProblem({ budget: 1.5, tasks: [] }), (e) => e.code === 'INVALID_SCHEMA');
  assert.throws(
    () => validateProblem({ budget: 5, tasks: [{ id: 'A', modes: [{ duration: -1, cost: 0 }] }] }),
    (e) => e.code === 'INVALID_SCHEMA',
  );
  assert.throws(
    () => validateProblem({ budget: 5, tasks: [{ id: 'A', modes: [] }] }),
    (e) => e.code === 'INVALID_SCHEMA',
  );
});
