import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { syncWorkspaces } from '../src/sync.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mold-plan-sync-'));
}

const DEF = {
  molds: [{ id: 'M1', life: 100, changeTime: 2 }],
  shifts: [{ id: 'S1', budget: 500 }],
  jobs: [],
};

function defChanges(def) {
  return [
    ...def.molds.map((mold) => ({ type: 'addMold', mold })),
    ...def.shifts.map((shift) => ({ type: 'addShift', shift })),
    ...def.jobs.map((job) => ({ type: 'addJob', job })),
  ];
}

function pair() {
  const dirA = tmpdir();
  const dirB = tmpdir();
  const a = new Workspace(dirA, 'TA').open();
  const b = new Workspace(dirB, 'TB').open();
  a.applyBatch(defChanges(DEF));
  b.applyBatch(defChanges(DEF));
  return { a, b, dirA, dirB };
}

test('bidirectional sync exchanges increments and converges version vectors', () => {
  const { a, b } = pair();
  a.applyBatch([
    { type: 'addJob', job: { id: 'JA', units: 10, eligible: ['M1'] } },
    { type: 'assign', jobId: 'JA', shift: 0, mold: 'M1' },
  ]);
  b.applyBatch([
    { type: 'addJob', job: { id: 'JB', units: 20, eligible: ['M1'] } },
    { type: 'assign', jobId: 'JB', shift: 0, mold: 'M1' },
  ]);
  const result = syncWorkspaces(a, b);
  assert.equal(result.converged, true);
  assert.deepEqual(result.vectorA, result.vectorB);
  assert.ok(a.state.jobs.has('JB'), 'A learned B job');
  assert.ok(b.state.jobs.has('JA'), 'B learned A job');
  assert.deepEqual(a.state.assignment.get('JB'), { shift: 0, mold: 'M1' });
  assert.deepEqual(b.state.assignment.get('JA'), { shift: 0, mold: 'M1' });
  // idempotent: second sync exchanges nothing
  const again = syncWorkspaces(a, b);
  assert.equal(again.appliedAB, 0);
  assert.equal(again.appliedBA, 0);
  a.close();
  b.close();
});

test('sync conflict on shared resource: over-allocation becomes pending, not unsatisfiable', () => {
  const { a, b } = pair();
  // both terminals independently consume 60 of M1's 100-unit life
  a.applyBatch([
    { type: 'addJob', job: { id: 'JA', units: 60, eligible: ['M1'] } },
    { type: 'assign', jobId: 'JA', shift: 0, mold: 'M1' },
  ]);
  b.applyBatch([
    { type: 'addJob', job: { id: 'JB', units: 60, eligible: ['M1'] } },
    { type: 'assign', jobId: 'JB', shift: 0, mold: 'M1' },
  ]);
  const result = syncWorkspaces(a, b);
  assert.equal(result.converged, true);
  for (const ws of [a, b]) {
    const usage = ws.state.usage.get('M1');
    assert.equal(usage, 120, 'both increments merged');
    assert.deepEqual(ws.state.pending, [{ mold: 'M1', used: 120, life: 100 }]);
    assert.equal(ws.state.feasible, false);
  }
  assert.ok(result.pendingA.length > 0 && result.pendingB.length > 0);
  a.close();
  b.close();
});

test('version vectors: duplicate records are skipped on re-sync', () => {
  const { a, b } = pair();
  a.applyBatch([{ type: 'addJob', job: { id: 'JX', units: 5, eligible: ['M1'] } }]);
  syncWorkspaces(a, b);
  const batchesBefore = b.state.batches.length;
  syncWorkspaces(a, b);
  assert.equal(b.state.batches.length, batchesBefore, 'no duplicate application');
  assert.deepEqual(a.vector, b.vector);
  a.close();
  b.close();
});
