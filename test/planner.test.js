'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Planner, PlanError } = require('../src/planner');
const { tmpdir } = require('./helpers');

function bootedPlanner(dir) {
  const p = Planner.open(dir, { termId: 'T1' });
  p.op('shift', { id: 'S1', capacity: 300 });
  p.op('shift', { id: 'S2', capacity: 300 });
  p.op('shift', { id: 'S3', capacity: 300 });
  p.op('mold', { id: 'M1', life: 100000 });
  p.op('mold', { id: 'M2', life: 100000 });
  p.op('setup', { mold: 'M1', minutes: 10 });
  p.op('setup', { mold: 'M2', minutes: 12 });
  p.op('changeover', { from: 'M1', to: 'M2', minutes: 15 });
  p.op('changeover', { from: 'M2', to: 'M1', minutes: 15 });
  for (let i = 1; i <= 6; i++) {
    p.op('insert', { job: 'J' + i, mold: i % 2 ? 'M1' : 'M2', shots: 10, duration: 30 });
  }
  return p;
}

test('incremental recompute: insert only computes new cache keys', () => {
  const dir = tmpdir();
  const p = bootedPlanner(dir);
  const cold = p.plan();
  assert.equal(cold.feasible, true);
  assert.ok(cold.stats.order > 0);

  p.op('insert', { job: 'J7', mold: 'M1', shots: 10, duration: 30 });
  const warm = p.plan();
  assert.equal(warm.feasible, true);
  assert.ok(warm.stats.order > 0, 'some new masks computed');
  // A from-scratch solve of the same 7-job state recomputes everything.
  const fresh = Planner.open(dir).plan();
  assert.deepEqual(
    { feasible: warm.feasible, cost: warm.cost, planStr: warm.planStr },
    { feasible: fresh.feasible, cost: fresh.cost, planStr: fresh.planStr },
    'incremental result identical to full recompute'
  );
  assert.ok(warm.stats.order < fresh.stats.order,
    `incremental ${warm.stats.order} < full ${fresh.stats.order}`);

  // Pin change invalidates only the assignment layer: zero order recomputes.
  p.op('assign', { job: 'J7', shift: 'S2' });
  const repin = p.plan();
  assert.equal(repin.feasible, true);
  assert.equal(repin.stats.order, 0);
  assert.ok(repin.stats.assign > 0);
  assert.equal(repin.plan.find((b) => b.jobs.includes('J7')).shift, 'S2');

  // Unassign frees the job again; solver chooses placement.
  p.op('unassign', { job: 'J7' });
  const free = p.plan();
  assert.equal(free.feasible, true);
  assert.equal(free.stats.order, 0);
});

test('budget boundary via planner: feasible=false keeps last feasible certificate', () => {
  const dir = tmpdir();
  const p = Planner.open(dir, { termId: 'T1' });
  p.op('shift', { id: 'S1', capacity: 210 });
  p.op('mold', { id: 'M1', life: 1000 });
  p.op('setup', { mold: 'M1', minutes: 10 });
  p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 100 });
  p.op('insert', { job: 'J2', mold: 'M1', shots: 10, duration: 100 });
  const ok = p.apply();
  assert.equal(ok.feasible, true);
  assert.equal(ok.cost, 210);
  const cert = ok.certificate;
  assert.ok(cert && cert.planStr);

  p.op('shift', { id: 'S1', capacity: 209 }); // one minute under budget
  const no = p.apply();
  assert.equal(no.feasible, false);
  assert.deepEqual(no.certificate, cert, 'last feasible certificate retained');

  // Recovery keeps the certificate too.
  const reopened = Planner.open(dir);
  const again = reopened.plan();
  assert.equal(again.feasible, false);
  assert.deepEqual(again.certificate, cert);
});

test('pending jobs are excluded, never treated as unsatisfiable', () => {
  const p = bootedPlanner(tmpdir());
  p.op('insert', { job: 'JX', mold: 'M1', shots: 200000, duration: 10 }); // exceeds mold life
  const no = p.plan();
  assert.equal(no.feasible, false);
  p.op('pend', { job: 'JX' });
  const res = p.plan();
  assert.equal(res.feasible, true);
  assert.deepEqual(res.pending, ['JX']);
});

test('hierarchical rollback: locked maintenance survives batch rollback', () => {
  const dir = tmpdir();
  const p = Planner.open(dir, { termId: 'T1' });
  p.op('shift', { id: 'S1', capacity: 300 });
  p.op('mold', { id: 'M1', life: 1000 });
  p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 30 });
  p.apply(); // batch 0

  p.op('maintenance', { id: 'mnt1', mold: 'M1', shift: 'S1', duration: 60, locked: true });
  p.apply(); // batch 1

  p.op('insert', { job: 'J2', mold: 'M1', shots: 10, duration: 30 });
  p.apply(); // batch 2

  const r = p.rollback(2); // drops batches 1 and 2, locked maintenance preserved
  assert.equal(r.rolledBack, 2);
  assert.equal(r.preservedLockedMaintenance, 1);
  assert.equal(p.state.jobs.J2, undefined, 'J2 rolled back');
  assert.ok(p.state.jobs.J1, 'J1 (batch 0) survives rollback of batches 1-2');
  assert.equal(p.state.maintenance.length, 1, 'locked maintenance preserved');
  assert.equal(p.state.maintenance[0].id, 'mnt1');

  // Persisted across reopen.
  const reopened = Planner.open(dir);
  assert.equal(reopened.state.maintenance.length, 1);
  assert.deepEqual(Object.keys(reopened.state.jobs), ['J1']);
});

test('rollback out of bounds raises ROLLBACK (exit code 6)', () => {
  const p = Planner.open(tmpdir(), { termId: 'T1' });
  p.op('shift', { id: 'S1', capacity: 100 });
  p.apply();
  assert.throws(() => p.rollback(2), (e) => {
    assert.ok(e instanceof PlanError);
    assert.equal(e.code, 'ROLLBACK');
    assert.equal(e.exitCode, 6);
    return true;
  });
  assert.throws(() => p.rollback(0), (e) => e.code === 'ROLLBACK');
  p.rollback(1);
  assert.throws(() => p.rollback(1), (e) => e.code === 'ROLLBACK');
});
