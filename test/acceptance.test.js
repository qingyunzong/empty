import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { enumerateAll } from '../src/solver.js';
import { buildState } from '../src/model.js';

const startsOf = (schedule) =>
  Object.fromEntries((schedule.assignments ?? []).map((a) => [a.id, a.start]));

// Scenario 1: tight capacity with several optima; the lexicographically
// smallest start vector (task-id order) must win.
test('scenario 1: tie among multiple optima is broken lexicographically', () => {
  const engine = new Engine({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, due: 4 },
      { id: 'b', line: 'L1', duration: 2, due: 4 },
    ],
    capacity: { L1: [{ start: 0, end: 4, capacity: 1 }] },
  });
  const { schedule } = engine.schedule();
  assert.equal(schedule.status, 'optimal');
  assert.equal(schedule.lmax, 0);
  // optima: (a@0,b@2) and (a@2,b@0); lexicographic order picks a@0
  assert.deepEqual(startsOf(schedule), { a: 0, b: 2 });

  // independent verification: enumerate every optimum and check the choice
  const state = buildState({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, due: 4 },
      { id: 'b', line: 'L1', duration: 2, due: 4 },
    ],
    capacity: { L1: [{ start: 0, end: 4, capacity: 1 }] },
  });
  const all = enumerateAll(state);
  assert.equal(all.count, 2); // exactly two feasible (= optimal) assignments
  assert.deepEqual(all.best.starts, [0, 2]);
});

// Scenario 2: conflicting due dates are proven infeasible with a minimum
// constraint subset as certificate.
test('scenario 2: due conflict is proven infeasible with minimum subset', () => {
  const engine = new Engine({
    tasks: [
      { id: 'x', line: 'L1', duration: 2, due: 2 },
      { id: 'y', line: 'L1', duration: 2, due: 2 },
      { id: 'z', line: 'L1', duration: 1, due: 9 },
    ],
    capacity: { L1: [{ start: 0, end: 8, capacity: 1 }] },
  });
  const { schedule } = engine.schedule();
  assert.equal(schedule.status, 'infeasible');
  const cert = schedule.certificate;
  assert.equal(cert.method, 'exhaustive-enumeration');
  const subset = cert.minInfeasibleSubset;
  const taskIds = subset.filter((e) => e.type === 'task').map((e) => e.id).sort();
  assert.deepEqual(taskIds, ['x', 'y']);
  assert.equal(subset.length, 2);
});

// Scenario 3: undoing a capacity cut restores the original optimal schedule.
test('scenario 3: undo of capacity cut restores the original optimum', () => {
  const engine = new Engine({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, due: 4 },
      { id: 'b', line: 'L1', duration: 2, due: 4 },
    ],
    capacity: { L1: [{ start: 0, end: 4, capacity: 2 }] },
  });
  const original = engine.schedule().schedule;
  assert.equal(original.lmax, -2);
  assert.deepEqual(startsOf(original), { a: 0, b: 0 });

  const cut = engine.apply({ op: 'setCapacity', capacity: { L1: [{ start: 0, end: 4, capacity: 1 }] } });
  assert.equal(cut.schedule.status, 'optimal');
  assert.equal(cut.schedule.lmax, 0); // one task must finish at 4
  assert.deepEqual(startsOf(cut.schedule), { a: 0, b: 2 });
  assert.deepEqual(cut.affected, ['b']);

  const undone = engine.undo();
  assert.equal(undone.undone, 'set capacity');
  assert.deepEqual(startsOf(undone.schedule), startsOf(original));
  assert.equal(undone.schedule.lmax, original.lmax);

  const redone = engine.redo();
  assert.deepEqual(startsOf(redone.schedule), { a: 0, b: 2 });
});

// Scenario 3b: undoing a capacity cut that made the problem infeasible
// restores feasibility and the original schedule.
test('scenario 3b: undo of an infeasibility-inducing cut restores the optimum', () => {
  const engine = new Engine({
    tasks: [
      { id: 'a', line: 'L1', duration: 2, due: 2 },
      { id: 'b', line: 'L1', duration: 2, due: 2 },
    ],
    capacity: { L1: [{ start: 0, end: 4, capacity: 2 }] },
  });
  const original = engine.schedule().schedule;
  const cut = engine.apply({ op: 'setCapacity', capacity: { L1: [{ start: 0, end: 4, capacity: 1 }] } });
  assert.equal(cut.schedule.status, 'infeasible');
  const undone = engine.undo();
  assert.equal(undone.schedule.status, 'optimal');
  assert.deepEqual(startsOf(undone.schedule), startsOf(original));
});
