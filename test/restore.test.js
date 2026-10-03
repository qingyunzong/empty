'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, writeJson, runCli, runCliJson } = require('./helper');

const scenario = {
  name: 'fault-demo',
  stations: [
    {
      id: 'X',
      link: 'LX',
      battery: 2,
      windows: [
        { id: 'w1', start: 0, end: 2, energy: 1 },
        { id: 'w2', start: 2, end: 4, energy: 1 },
        { id: 'w3', start: 10, end: 12, energy: 1 },
        { id: 'w4', start: 12, end: 14, energy: 1 },
      ],
    },
    {
      id: 'Y',
      link: 'LY',
      battery: 1,
      windows: [{ id: 'y1', start: 0, end: 2, energy: 1 }],
    },
  ],
  contracts: [
    { id: 'CX', station: 'X', min: 2 },
    { id: 'CY', station: 'Y', min: 1 },
  ],
};

function setup(dir) {
  const state = path.join(dir, 'state');
  runCliJson(['ingest', writeJson(dir, 'scenario.json', scenario), '--state', state]);
  runCliJson(['plan', '--state', state]);
  return state;
}

test('fail preempts unlocked windows and issues revocation tokens', () => {
  const dir = tmpDir();
  const state = setup(dir);
  const faultFile = writeJson(dir, 'fault.json', { id: 'F1', station: 'X', start: 0, end: 4 });
  const out = runCliJson(['fail', faultFile, '--state', state]);
  assert.deepEqual(out.preempted, ['w1', 'w2']);
  assert.equal(out.revocations.length, 2);
  for (const rev of out.revocations) {
    assert.match(rev.token, /^[0-9a-f]{64}$/);
    assert.equal(rev.faultId, 'F1');
  }
  // station recovers using windows outside the fault interval
  assert.deepEqual(out.plan.schedule.X.map((w) => w.window), ['w3', 'w4']);
  assert.equal(out.plan.unmet.length, 0);
  // remote station untouched
  assert.deepEqual(out.plan.schedule.Y.map((w) => w.window), ['y1']);
});

test('locked windows are never preempted', () => {
  const dir = tmpDir();
  const locked = JSON.parse(JSON.stringify(scenario));
  locked.stations[0].windows[0].locked = true; // w1 locked
  const state = path.join(dir, 'state');
  runCliJson(['ingest', writeJson(dir, 'scenario.json', locked), '--state', state]);
  runCliJson(['plan', '--state', state]);
  const faultFile = writeJson(dir, 'fault.json', { id: 'F1', station: 'X', start: 0, end: 4 });
  const out = runCliJson(['fail', faultFile, '--state', state]);
  assert.deepEqual(out.keptLocked, ['w1']);
  assert.deepEqual(out.preempted, ['w2']);
  assert.equal(out.revocations.length, 1);
  assert.equal(out.revocations[0].window, 'w2');
  assert.ok(out.plan.schedule.X.some((w) => w.window === 'w1'), 'locked window stays scheduled');
});

test('restore proves history outside the fault interval is unchanged', () => {
  const dir = tmpDir();
  const state = setup(dir);
  const faultFile = writeJson(dir, 'fault.json', { id: 'F1', station: 'X', start: 0, end: 4 });
  runCliJson(['fail', faultFile, '--state', state]);
  const out = runCliJson(['restore', 'F1', '--state', state]);
  assert.equal(out.proof.faultId, 'F1');
  assert.deepEqual(out.proof.interval, { start: 0, end: 4 });
  assert.equal(out.proof.outsideUnchanged, true);
  assert.deepEqual(out.proof.outsideBefore, ['w3', 'w4']);
  assert.deepEqual(out.proof.outsideAfter, ['w3', 'w4']);
  assert.equal(out.proof.outsideHashBefore, out.proof.outsideHashAfter);
});

test('restore of unknown fault exits 6', () => {
  const dir = tmpDir();
  const state = setup(dir);
  const res = runCli(['restore', 'NOPE', '--state', state]);
  assert.equal(res.code, 6);
  assert.match(res.stderr, /unknown fault/);
});

test('acceptance 4: replay after crash reproduces identical state', () => {
  // reference run: full sequence without crash
  const refDir = tmpDir();
  const refState = setup(refDir);
  const refFault = writeJson(refDir, 'fault.json', { id: 'F1', station: 'X', start: 0, end: 4 });
  const refFail = runCliJson(['fail', refFault, '--state', refState]);
  const refRestore = runCliJson(['restore', 'F1', '--state', refState]);

  // crash run: delete derived state right after the fault, then keep going
  const crashDir = tmpDir();
  const crashState = setup(crashDir);
  const crashFault = writeJson(crashDir, 'fault.json', { id: 'F1', station: 'X', start: 0, end: 4 });
  runCliJson(['fail', crashFault, '--state', crashState]);
  for (const f of ['state.json', 'plan.json']) {
    fs.unlinkSync(path.join(crashState, f));
  }
  const rebuilt = runCliJson(['plan', '--state', crashState]);
  assert.equal(rebuilt.planId, refFail.plan.planId, 'replay after crash must match');
  const crashRestore = runCliJson(['restore', 'F1', '--state', crashState]);
  assert.equal(crashRestore.plan.planId, refRestore.plan.planId, 'restore after replay must match');
  assert.deepEqual(crashRestore.proof, refRestore.proof);
});
