import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState,
  beginBatch,
  recordChange,
  rollbackLastBatch,
  recomputeIncremental,
  recomputeFull,
  cloneState,
  MoldPlanError,
} from '../src/model.js';

function baseState() {
  const s = emptyState();
  const b = beginBatch(s);
  recordChange(s, b, { type: 'addMold', mold: { id: 'M1', life: 100, changeTime: 2 } });
  recordChange(s, b, { type: 'addMold', mold: { id: 'M2', life: 80, changeTime: 3 } });
  recordChange(s, b, { type: 'addShift', shift: { id: 'S1', budget: 100 } });
  recordChange(s, b, { type: 'addShift', shift: { id: 'S2', budget: 80 } });
  recordChange(s, b, { type: 'addJob', job: { id: 'J1', units: 40, eligible: ['M1'] } });
  recordChange(s, b, { type: 'addJob', job: { id: 'J2', units: 30, eligible: ['M1', 'M2'] } });
  return s;
}

test('change capture: insert/assign/unassign recorded with inverses', () => {
  const s = baseState();
  const b = beginBatch(s);
  recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' });
  recordChange(s, b, { type: 'unassign', jobId: 'J1' });
  recordChange(s, b, { type: 'addJob', job: { id: 'J3', units: 10, eligible: ['M2'] } });
  assert.equal(b.changes.length, 3);
  assert.deepEqual(b.changes[0].inverse, { type: 'unassign', jobId: 'J1' });
  assert.deepEqual(b.changes[1].inverse, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' });
  assert.equal(b.changes[2].inverse.type, 'removeJob');
});

test('incremental recompute matches full recompute after each change', () => {
  const s = baseState();
  const ops = [
    { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' },
    { type: 'assign', jobId: 'J2', shift: 1, mold: 'M2' },
    { type: 'unassign', jobId: 'J1' },
    { type: 'assign', jobId: 'J1', shift: 1, mold: 'M1' },
    { type: 'unassign', jobId: 'J2' },
    { type: 'assign', jobId: 'J2', shift: 0, mold: 'M1' },
  ];
  const b = beginBatch(s);
  for (const op of ops) {
    recordChange(s, b, op);
    recomputeIncremental(s, [op.jobId]);
    const inc = cloneState(s);
    recomputeFull(inc);
    assert.deepEqual(inc.usage, s.usage, `usage diverged after ${op.type}`);
    assert.deepEqual(inc.shiftLoad, s.shiftLoad, `shiftLoad diverged after ${op.type}`);
    assert.deepEqual(
      new Map([...inc.moldShifts].map(([k, v]) => [k, [...v].sort()])),
      new Map([...s.moldShifts].map(([k, v]) => [k, [...v].sort()])),
      `moldShifts diverged after ${op.type}`
    );
    assert.equal(inc.feasible, s.feasible);
    assert.deepEqual(inc.pending, s.pending);
  }
});

test('hierarchical rollback: unlocked batch rolls back fully', () => {
  const s = baseState();
  const before = cloneState(s);
  const b = beginBatch(s);
  recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' });
  recordChange(s, b, { type: 'assign', jobId: 'J2', shift: 1, mold: 'M2' });
  recomputeIncremental(s, ['J1', 'J2']);
  rollbackLastBatch(s);
  recomputeFull(s);
  assert.equal(s.assignment.size, 0);
  assert.deepEqual([...s.jobs.keys()], [...before.jobs.keys()]);
  assert.equal(s.batches.length, before.batches.length);
});

test('hierarchical rollback: locked mold maintenance survives, ROLLBACK raised', () => {
  const s = baseState();
  const b = beginBatch(s, ['M1']); // M1 maintenance locked for this batch
  recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' });
  recordChange(s, b, { type: 'assign', jobId: 'J2', shift: 1, mold: 'M2' });
  assert.throws(() => rollbackLastBatch(s), (err) => {
    assert.equal(err.code, 'ROLLBACK');
    return true;
  });
  // locked change kept, unlocked change rolled back
  assert.deepEqual(s.assignment.get('J1'), { shift: 0, mold: 'M1' });
  assert.equal(s.assignment.has('J2'), false);
  assert.equal(s.batches.length, 2, 'batch kept because rollback was out of bounds');
});

test('rollback of empty stack raises ROLLBACK', () => {
  const s = emptyState();
  assert.throws(() => rollbackLastBatch(s), (err) => err.code === 'ROLLBACK');
});

test('budget feasibility flips correctly and certificate is retained', () => {
  const s = baseState();
  const b = beginBatch(s);
  recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' });
  recordChange(s, b, { type: 'assign', jobId: 'J2', shift: 0, mold: 'M1' });
  recomputeIncremental(s, ['J1', 'J2']);
  assert.equal(s.feasible, true);
  const cert = s.certificate;
  assert.ok(cert);
  // push shift 0 over budget: J3 50 units -> load 120 > 100
  recordChange(s, b, { type: 'addJob', job: { id: 'J3', units: 50, eligible: ['M1'] } });
  recordChange(s, b, { type: 'assign', jobId: 'J3', shift: 0, mold: 'M1' });
  recomputeIncremental(s, ['J3']);
  assert.equal(s.feasible, false);
  assert.deepEqual(s.certificate, cert, 'last feasible certificate must be retained');
  // mold over-allocation is pending, not unsatisfiable
  recordChange(s, b, { type: 'addJob', job: { id: 'J4', units: 60, eligible: ['M2'] } });
  recordChange(s, b, { type: 'assign', jobId: 'J4', shift: 1, mold: 'M2' });
  recomputeIncremental(s, ['J4']);
  assert.ok(s.pending.some((p) => p.mold === 'M2' && p.used === 60 && p.life === 80) === false);
  recordChange(s, b, { type: 'addJob', job: { id: 'J5', units: 90, eligible: ['M2'] } });
  recordChange(s, b, { type: 'assign', jobId: 'J5', shift: 1, mold: 'M2' });
  recomputeIncremental(s, ['J5']);
  assert.ok(s.pending.some((p) => p.mold === 'M2' && p.used === 150 && p.life === 80));
  assert.equal(s.feasible, false);
  assert.deepEqual(s.certificate, cert, 'pending must not clobber the certificate');
});

test('unknown references raise MODEL errors', () => {
  const s = baseState();
  const b = beginBatch(s);
  assert.throws(() => recordChange(s, b, { type: 'assign', jobId: 'NOPE', shift: 0, mold: 'M1' }), MoldPlanError);
  assert.throws(() => recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 9, mold: 'M1' }), MoldPlanError);
  assert.throws(() => recordChange(s, b, { type: 'assign', jobId: 'J1', shift: 0, mold: 'M2' }), MoldPlanError); // ineligible
});
