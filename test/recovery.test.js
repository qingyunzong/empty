import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { Journal } from '../src/journal.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mold-plan-'));
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
  ],
};

function defChanges(def) {
  return [
    ...def.molds.map((mold) => ({ type: 'addMold', mold })),
    ...def.shifts.map((shift) => ({ type: 'addShift', shift })),
    ...def.jobs.map((job) => ({ type: 'addJob', job })),
  ];
}

test('fault point 1: journal append — torn tail ignored, complete records replayed', () => {
  const dir = tmpdir();
  // write a journal by hand: one complete batch + a torn trailing line
  const journalFile = path.join(dir, 'journal.log');
  const rec = {
    type: 'batch',
    id: 'B1',
    origin: { terminal: 'T1', seq: 1 },
    lockedMolds: [],
    changes: defChanges(DEF),
  };
  fs.writeFileSync(journalFile, JSON.stringify(rec) + '\n' + '{"type":"batch","id":"B2","cha');
  const ws = new Workspace(dir, 'T1').open();
  try {
    assert.equal(ws.recovered.journalReplayed, 1, 'complete record replayed');
    assert.equal(ws.state.jobs.size, 2);
    assert.equal(ws.state.molds.size, 2);
    assert.equal(ws.state.calendar.shifts.length, 2);
    // torn record must not appear
    assert.equal(ws.state.batches.length, 1);
  } finally {
    ws.close();
  }
});

test('fault point 1b: journal replay restores assignments after crash without snapshot', () => {
  const dir = tmpdir();
  const ws1 = new Workspace(dir, 'T1').open();
  ws1.applyBatch(defChanges(DEF));
  ws1.applyBatch([{ type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' }]);
  ws1.close();
  // simulate crash after journal append but before snapshot: remove plan.json
  fs.unlinkSync(path.join(dir, 'plan.json'));
  const ws2 = new Workspace(dir, 'T1').open();
  try {
    assert.deepEqual(ws2.state.assignment.get('J1'), { shift: 0, mold: 'M1' });
    assert.equal(ws2.state.shiftLoad[0], 40);
  } finally {
    ws2.close();
  }
});

test('fault point 2: plan.tmp rename — leftover temp plan discarded, committed plan kept', () => {
  const dir = tmpdir();
  const ws1 = new Workspace(dir, 'T1').open();
  ws1.applyBatch(defChanges(DEF));
  ws1.applyBatch([{ type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' }]);
  ws1.close();
  // simulate crash between tmp write and rename: stale plan.tmp with junk
  fs.writeFileSync(path.join(dir, 'plan.tmp'), '{"jobs":[999],"corrupt":');
  const ws2 = new Workspace(dir, 'T1').open();
  try {
    assert.equal(ws2.recovered.tmpPlanDiscarded, true);
    assert.equal(fs.existsSync(path.join(dir, 'plan.tmp')), false, 'temp plan removed');
    // committed plan.json is authoritative and intact
    assert.deepEqual(ws2.state.assignment.get('J1'), { shift: 0, mold: 'M1' });
    assert.equal(ws2.state.jobs.size, 2);
  } finally {
    ws2.close();
  }
});

test('fault point 3: budget manifest commit — committed manifest survives, stale tmp dropped', () => {
  const dir = tmpdir();
  const ws1 = new Workspace(dir, 'T1').open();
  ws1.applyBatch(defChanges(DEF));
  ws1.applyBatch([{ type: 'assign', jobId: 'J1', shift: 0, mold: 'M1' }]);
  const committed = ws1.manifest();
  ws1.close();
  const manifestBefore = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
  assert.deepEqual(manifestBefore.shiftLoad, committed.shiftLoad);
  // simulate crash before a new manifest commit: stale budget.tmp
  fs.writeFileSync(path.join(dir, 'budget.tmp'), '{"shiftLoad":[9999]}');
  const ws2 = new Workspace(dir, 'T1').open();
  try {
    assert.equal(ws2.recovered.manifestKept, true, 'committed manifest preserved');
    assert.equal(fs.existsSync(path.join(dir, 'budget.tmp')), false, 'stale tmp manifest dropped');
    const manifestAfter = ws2.store.readManifest();
    assert.deepEqual(manifestAfter.shiftLoad, committed.shiftLoad);
    assert.deepEqual(manifestAfter.vector, committed.vector);
  } finally {
    ws2.close();
  }
});

test('journal fsync append is durable across reopen', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'journal.log');
  const j1 = new Journal(file).open();
  j1.append({ type: 'batch', id: 'B1' });
  j1.close();
  const j2 = new Journal(file).open();
  j2.append({ type: 'rollback', batch: 'B1' });
  j2.close();
  const records = Journal.replay(file);
  assert.equal(records.length, 2);
  assert.equal(records[1].type, 'rollback');
});
