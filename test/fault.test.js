'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Planner } = require('../src/planner');
const { tmpdir } = require('./helpers');

function bootedDir() {
  const dir = tmpdir();
  const p = Planner.open(dir, { termId: 'T1' });
  p.op('shift', { id: 'S1', capacity: 210 });
  p.op('mold', { id: 'M1', life: 1000 });
  p.op('setup', { mold: 'M1', minutes: 10 });
  p.op('insert', { job: 'J1', mold: 'M1', shots: 10, duration: 100 });
  p.op('insert', { job: 'J2', mold: 'M1', shots: 10, duration: 100 });
  p.apply();
  return dir;
}

test('fault point 1: torn journal append is truncated and valid prefix replayed', () => {
  const dir = bootedDir();
  const journalFile = path.join(dir, 'journal.log');
  const before = fs.readFileSync(journalFile, 'utf8');
  // Simulate a crash mid-append: partial JSON line without newline.
  fs.appendFileSync(journalFile, '{"opId":"T1-7","term":"T1","counter":7,"op":"ins');

  const p = Planner.open(dir);
  assert.equal(p.recovery.journalTruncated, true);
  assert.equal(Object.keys(p.state.jobs).length, 2, 'valid ops replayed');
  assert.equal(p.plan().feasible, true);
  // File truncated back to the valid prefix.
  assert.equal(fs.readFileSync(journalFile, 'utf8'), before);
});

test('fault point 2: orphan plan.tmp is discarded, committed plan kept', () => {
  const dir = bootedDir();
  const committed = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  // Simulate a crash between writing plan.tmp and renaming it.
  fs.writeFileSync(path.join(dir, 'plan.tmp'), '{"feasible":false,"garbage":true}');

  const p = Planner.open(dir);
  assert.equal(p.recovery.planTmpDiscarded, true);
  assert.equal(fs.existsSync(path.join(dir, 'plan.tmp')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'), committed);
  const res = p.plan();
  assert.equal(res.feasible, true);
  assert.equal(res.cost, 210);
});

test('fault point 3: uncommitted budget manifest rolled back, committed budget kept', () => {
  const dir = bootedDir();
  const committedBudget = fs.readFileSync(path.join(dir, 'budget.json'), 'utf8');
  // Simulate a crash after renaming budget.json but before writing the commit
  // marker: budget.json is uncommitted garbage.
  fs.writeFileSync(path.join(dir, 'budget.json'),
    JSON.stringify({ shifts: { S1: 1 }, molds: { M1: 0 } }, null, 2));

  const p = Planner.open(dir);
  assert.equal(p.recovery.budgetRestored, true);
  assert.equal(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'), committedBudget);
  assert.equal(p.state.shifts.S1.capacity, 210, 'committed budget wins');
  assert.equal(p.state.molds.M1.life, 1000);
  assert.equal(p.plan().feasible, true);
});

test('fault point 3b: leftover budget.tmp and uncommitted budget.json are discarded', () => {
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'budget.json'), '{"shifts":{"S1":5}}');
  fs.writeFileSync(path.join(dir, 'budget.tmp'), '{"shifts":{"S1":6}}');
  const p = Planner.open(dir);
  assert.equal(p.recovery.budgetDiscarded, true);
  assert.equal(fs.existsSync(path.join(dir, 'budget.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'budget.tmp')), false);
});
