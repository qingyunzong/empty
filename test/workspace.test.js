import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mold-plan-ws-'));
}

const DEF = {
  molds: [
    { id: 'M1', life: 100, changeTime: 2 },
    { id: 'M2', life: 80, changeTime: 3 },
  ],
  shifts: [
    { id: 'S1', budget: 100 },
    { id: 'S2', budget: 80 },
  ],
  jobs: [
    { id: 'J1', units: 40, eligible: ['M1'] },
    { id: 'J2', units: 30, eligible: ['M1', 'M2'] },
    { id: 'J3', units: 20, eligible: ['M2'] },
  ],
};

function defChanges(def) {
  return [
    ...def.molds.map((mold) => ({ type: 'addMold', mold })),
    ...def.shifts.map((shift) => ({ type: 'addShift', shift })),
    ...def.jobs.map((job) => ({ type: 'addJob', job })),
  ];
}

test('planner scenario: undo of last adjustment restores budget feasibility', () => {
  const dir = tmpdir();
  const ws = new Workspace(dir, 'T1').open();
  try {
    ws.applyBatch(defChanges(DEF));
    const planned = ws.plan();
    assert.equal(planned.feasible, true);
    const cert = ws.state.certificate;
    // planner moves J2 onto shift 1 with mold M2, then adds a heavy job that
    // blows the shift budget — the adjustment batch breaks feasibility
    ws.applyBatch([
      { type: 'unassign', jobId: 'J2' },
      { type: 'assign', jobId: 'J2', shift: 1, mold: 'M2' },
      { type: 'addJob', job: { id: 'JH', units: 90, eligible: ['M1'] } },
      { type: 'assign', jobId: 'JH', shift: 1, mold: 'M1' },
    ]);
    assert.equal(ws.state.feasible, false);
    assert.ok(ws.state.shiftLoad[1] > 80, 'adjustment exceeds shift budget');
    // undo the adjustment: budget must hold again
    ws.rollback();
    assert.equal(ws.state.feasible, true);
    for (let i = 0; i < ws.state.calendar.shifts.length; i++) {
      assert.ok(ws.state.shiftLoad[i] <= ws.state.calendar.shifts[i].budget);
    }
    assert.deepEqual(ws.state.certificate, cert, 'same optimal plan restored');
  } finally {
    ws.close();
  }
});

test('plan replaces a suboptimal manual assignment with the canonical optimum', () => {
  const dir = tmpdir();
  const ws = new Workspace(dir, 'T1').open();
  try {
    ws.applyBatch(defChanges(DEF));
    // manual suboptimal: spread across both shifts
    ws.applyBatch([
      { type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' },
      { type: 'assign', jobId: 'J2', shift: 1, mold: 'M2' },
      { type: 'assign', jobId: 'J3', shift: 1, mold: 'M2' },
    ]);
    const result = ws.plan();
    assert.equal(result.feasible, true);
    assert.deepEqual(result.cost, [1, 5], 'canonical optimum: 1 shift, setup 2+3');
    const shifts = new Set(ws.state.certificate.assignment.map((a) => a.shift));
    assert.equal(shifts.size, 1);
  } finally {
    ws.close();
  }
});

test('persistence: reopening a workspace restores plan, batches and certificate', () => {
  const dir = tmpdir();
  const ws1 = new Workspace(dir, 'T1').open();
  ws1.applyBatch(defChanges(DEF));
  ws1.plan();
  const cert = ws1.state.certificate;
  const batchCount = ws1.state.batches.length;
  ws1.close();
  const ws2 = new Workspace(dir, 'T1').open();
  try {
    assert.equal(ws2.state.feasible, true);
    assert.deepEqual(ws2.state.certificate, cert);
    assert.equal(ws2.state.batches.length, batchCount);
    // rollback still works after reload (inverses persisted)
    ws2.rollback();
    assert.equal(ws2.state.batches.length, batchCount - 1);
  } finally {
    ws2.close();
  }
});

test('unsatisfiable definition: feasible=false, certificate kept, pending not misreported', () => {
  const dir = tmpdir();
  const ws = new Workspace(dir, 'T1').open();
  try {
    ws.applyBatch(defChanges(DEF));
    ws.plan();
    const cert = ws.state.certificate;
    // add a job no budget can hold
    ws.applyBatch([{ type: 'addJob', job: { id: 'JHUGE', units: 500, eligible: ['M1'] } }]);
    const result = ws.plan();
    assert.equal(result.feasible, false);
    assert.deepEqual(ws.state.certificate, cert);
    assert.deepEqual(result.pending, [], 'no over-allocation: nothing pending');
  } finally {
    ws.close();
  }
});
