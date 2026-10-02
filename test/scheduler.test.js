import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { validateInstance } from '../src/validate.js';
import { solveCanonical } from '../src/solver.js';
import { makeInstance } from '../examples/gen.mjs';

const key = (s) => s.join(',');
const solSet = (list) => new Set(list.map(key));

test('incremental re-solve after due edit matches full recompute', () => {
  const raw = makeInstance(42, 12);
  const scheduler = new Scheduler(raw);

  const full1 = scheduler.solve();
  assert.equal(full1.status, 'FEASIBLE');
  assert.equal(full1.stats.incremental, false);

  scheduler.editJob('J3', { due: 17 });
  const inc = scheduler.solve();
  assert.equal(inc.status, 'FEASIBLE');
  assert.equal(inc.stats.incremental, true, 'only affected subproblems recomputed');
  assert.ok(
    inc.stats.statesComputed < full1.stats.statesComputed,
    `incremental recomputed ${inc.stats.statesComputed} of ${full1.stats.statesComputed} states`,
  );

  // ground truth: fresh full solve of the edited instance
  const fresh = solveCanonical(scheduler.instance);
  assert.deepEqual(inc.objective, fresh.objective);
  assert.deepEqual(solSet(inc.solutions), solSet(fresh.solutions));
  assert.equal(inc.enumerationHash, fresh.enumerationHash);
});

test('undo twice restores the original edit point; redo reapplies', () => {
  const raw = makeInstance(42, 12);
  const scheduler = new Scheduler(raw);
  const original = JSON.stringify(scheduler.instance.jobs);
  const base = scheduler.solve();

  scheduler.editJob('J3', { due: 17 });
  scheduler.editJob('J5', { work: 2, energy: 1 });
  assert.notEqual(JSON.stringify(scheduler.instance.jobs), original);

  assert.equal(scheduler.undo(), true);
  assert.equal(scheduler.undo(), true);
  assert.equal(JSON.stringify(scheduler.instance.jobs), original, 'restored to pre-edit state');

  const restored = scheduler.solve();
  assert.equal(restored.status, 'FEASIBLE');
  assert.deepEqual(restored.objective, base.objective);
  assert.deepEqual(solSet(restored.solutions), solSet(base.solutions));

  assert.equal(scheduler.redo(), true);
  assert.equal(scheduler.redo(), true);
  const edited = validateInstance(makeInstance(42, 12));
  edited.jobs.find((j) => j.id === 'J3').due = 17;
  Object.assign(edited.jobs.find((j) => j.id === 'J5'), { work: 2, energy: 1 });
  const expected = solveCanonical(edited);
  const reapplied = scheduler.solve();
  assert.deepEqual(reapplied.objective, expected.objective);
});

test('undo/redo on empty stacks is a no-op', () => {
  const scheduler = new Scheduler(makeInstance(1, 4));
  assert.equal(scheduler.undo(), false);
  assert.equal(scheduler.redo(), false);
});

test('editing into infeasibility yields UNSAT certificate via scheduler', () => {
  const raw = makeInstance(3, 5);
  const scheduler = new Scheduler(raw);
  assert.equal(scheduler.solve().status, 'FEASIBLE');
  const total = scheduler.instance.jobs.reduce((a, j) => a + j.energy, 0);
  scheduler.instance.energyBudget = total - 1; // tighten budget directly
  const result = scheduler.solve();
  assert.equal(result.status, 'UNSAT');
  assert.equal(result.certificate.minimal, true);
});
