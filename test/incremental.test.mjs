import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.mjs';
import { normalizeInstance } from '../src/schema.mjs';
import { solveNormalized } from '../src/solver.mjs';

const base = {
  jobs: [
    { id: 0, due: 8, work: 3, energy: 4, mold: 'A' },
    { id: 1, due: 10, work: 2, energy: 5, mold: 'B' },
    { id: 2, due: 14, work: 4, energy: 3, mold: 'C' },
    { id: 3, due: 18, work: 2, energy: 2, mold: 'A' },
    { id: 4, due: 22, work: 3, energy: 6, mold: 'B' },
    { id: 5, due: 30, work: 5, energy: 4, mold: 'C' },
    { id: 6, due: 34, work: 2, energy: 3, mold: 'A' },
    { id: 7, due: 40, work: 4, energy: 5, mold: 'B' },
  ],
  setup: {
    A: { B: 2, C: 3 },
    B: { A: 2, C: 1 },
    C: { A: 4, B: 2 },
  },
  energyBudget: 100,
};

function editedRaw(patchJob, patch) {
  const raw = structuredClone(base);
  Object.assign(raw.jobs[patchJob], patch);
  return raw;
}

function fullSolve(raw) {
  const v = normalizeInstance(raw);
  assert.equal(v.ok, true, v.error);
  return solveNormalized(v.instance);
}

function tieSet(res) {
  return new Set(res.schedules.map((s) => s.join(',')));
}

test('due edit: incremental re-solve matches a full re-solve', () => {
  const sched = new Scheduler(base);
  assert.equal(sched.result.status, 'FEASIBLE');

  const r1 = sched.editJob(2, { due: 5 });
  const fresh = fullSolve(editedRaw(2, { due: 5 }));
  assert.deepEqual(r1.objective, fresh.objective);
  assert.deepEqual(tieSet(r1), tieSet(fresh));

  // Incrementality: phase-1 subproblems are due-independent, so the shared
  // cache must serve hits instead of recomputing every state.
  assert.ok(sched.lastStats.p1Hits > 0, 'expected phase-1 cache hits');
  const cold = { p1Computed: 0, p1Hits: 0, p2Nodes: 0 };
  solveNormalized(normalizeInstance(editedRaw(2, { due: 5 })).instance, { stats: cold });
  assert.ok(sched.lastStats.p1Computed < cold.p1Computed,
    `incremental computed ${sched.lastStats.p1Computed} vs cold ${cold.p1Computed}`);
});

test('work edit invalidates only affected subproblems and stays exact', () => {
  const sched = new Scheduler(base);
  const r1 = sched.editJob(4, { work: 6, energy: 8 });
  const fresh = fullSolve(editedRaw(4, { work: 6, energy: 8 }));
  assert.deepEqual(r1.objective, fresh.objective);
  assert.deepEqual(tieSet(r1), tieSet(fresh));
  assert.ok(sched.lastStats.p1Hits > 0, 'unaffected subproblems should be reused');
});

test('undo twice restores the original edit point; redo replays it', () => {
  const sched = new Scheduler(base);
  const r0 = sched.result;

  const r1 = sched.editJob(2, { due: 5 });
  sched.editJob(3, { due: 40 });

  assert.equal(sched.undo(), true);
  assert.deepEqual(sched.result.objective, r1.objective);
  assert.deepEqual(tieSet(sched.result), tieSet(r1));

  assert.equal(sched.undo(), true);
  assert.deepEqual(sched.result.objective, r0.objective);
  assert.deepEqual(tieSet(sched.result), tieSet(r0));
  assert.deepEqual(sched.norm.jobs, normalizeInstance(base).instance.jobs);

  assert.equal(sched.redo(), true);
  assert.deepEqual(sched.result.objective, r1.objective);

  assert.equal(sched.redo(), true, 'redo replays the second edit');
  assert.equal(sched.undo(), true);
  assert.equal(sched.undo(), true);
  assert.equal(sched.undo(), false, 'undo stack exhausted');
});

test('budget edit can flip FEASIBLE/UNSAT and is undoable', () => {
  const sched = new Scheduler(base);
  const total = sched.result.objective.energy;
  const r1 = sched.setEnergyBudget(total - 1);
  assert.equal(r1.status, 'UNSAT');
  assert.equal(sched.undo(), true);
  assert.equal(sched.result.status, 'FEASIBLE');
});
