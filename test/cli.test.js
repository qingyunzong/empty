'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, runCli } = require('./helpers');

function addPass(dir, id, task, start, end, rate, extra = []) {
  const r = runCli(dir, ['pass', 'add', '--id', id, '--task', task,
    '--start', String(start), '--end', String(end), '--elev', '45',
    '--rate', String(rate), '--onboard', '1000000000', ...extra]);
  assert.equal(r.status, 0, `pass add ${id}: ${r.stderr}`);
  return r.json;
}

test('error: negative elevation exits 9', () => {
  const dir = tmpDir();
  const r = runCli(dir, ['pass', 'add', '--id', 'p1', '--task', 't1',
    '--start', '0', '--end', '10', '--elev', '-1', '--rate', '10', '--onboard', '100']);
  assert.equal(r.status, 9);
  assert.match(r.stderr, /negative elevation/);
});

test('error: rate exceeding link max exits 9', () => {
  const dir = tmpDir();
  const r = runCli(dir, ['pass', 'add', '--id', 'p1', '--task', 't1',
    '--start', '0', '--end', '10', '--elev', '10', '--rate', '2000000000', '--onboard', '100']);
  assert.equal(r.status, 9);
  assert.match(r.stderr, /exceeds link max/);
  // Explicit lower link max also enforced.
  const r2 = runCli(dir, ['pass', 'add', '--id', 'p2', '--task', 't1',
    '--start', '0', '--end', '10', '--elev', '10', '--rate', '200', '--onboard', '100',
    '--max-rate', '100']);
  assert.equal(r2.status, 9);
});

test('acceptance 2: weather correction shortening a pass only affects intersecting tasks', () => {
  const dir = tmpDir();
  // pA [0,100] beats pC [50,120] (1000 > 700 bytes); pB [300,400] is disjoint.
  addPass(dir, 'pA', 'taskA', 0, 100, 10);
  addPass(dir, 'pC', 'taskC', 50, 120, 10);
  addPass(dir, 'pB', 'taskB', 300, 400, 10);
  const s1 = runCli(dir, ['schedule']);
  assert.equal(s1.status, 0);
  assert.deepEqual(s1.json.bytesPerTask ?? undefined, undefined);
  assert.equal(s1.json.assignments.pA.bytes, 1000);
  assert.equal(s1.json.assignments.pB.bytes, 1000);
  assert.ok(!s1.json.assignments.pC);

  // Shorten pA to [0,40]: pC [50,120] no longer intersects -> scheduled.
  const c = runCli(dir, ['correct', '--id', 'pA', '--start', '0', '--end', '40']);
  assert.equal(c.status, 0);
  assert.deepEqual(c.json.affectedTasks, ['taskA', 'taskC']);
  assert.ok(!c.json.affectedTasks.includes('taskB'), 'non-intersecting task unaffected');

  const s2 = runCli(dir, ['schedule']);
  assert.equal(s2.json.assignments.pA.bytes, 400);
  assert.equal(s2.json.assignments.pC.bytes, 700);
  assert.equal(s2.json.assignments.pB.bytes, 1000, 'taskB allocation unchanged');
});

test('drop distinguishes weather/conflict/quota; pending weather not counted as failure', () => {
  const dir = tmpDir();
  addPass(dir, 'pW', 't1', 0, 100, 10);
  addPass(dir, 'pP', 't2', 200, 300, 10);
  addPass(dir, 'pQ', 't3', 400, 500, 10);
  let r = runCli(dir, ['drop', '--id', 'pW', '--reason', 'weather']);
  assert.equal(r.status, 0);
  assert.equal(r.json.loss.weather, 1000);
  r = runCli(dir, ['drop', '--id', 'pP', '--reason', 'weather', '--pending']);
  assert.equal(r.json.loss.pending, 1000);
  assert.equal(r.json.loss.weather, 1000, 'pending weather not added to weather failures');
  r = runCli(dir, ['drop', '--id', 'pQ', '--reason', 'quota']);
  assert.equal(r.json.loss.quota, 1000);
  r = runCli(dir, ['drop', '--id', 'pQ', '--reason', 'bogus']);
  assert.equal(r.status, 2);
});

test('undo: multi-level to pass boundaries, deterministic replay, confirmed bytes exit 9', () => {
  const dir = tmpDir();
  addPass(dir, 'p1', 't1', 0, 100, 10);
  addPass(dir, 'p2', 't2', 200, 300, 10);
  const s1 = runCli(dir, ['schedule']);
  assert.equal(s1.status, 0);
  const timeline1 = JSON.stringify(s1.json.timeline);

  // Undo the schedule (lands on pass boundary after p2 add).
  let r = runCli(dir, ['undo', '--steps', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.undone, 1);

  // Replaying the same schedule yields identical output (deterministic).
  const s2 = runCli(dir, ['schedule']);
  assert.equal(JSON.stringify(s2.json.timeline), timeline1);

  // Landing on a non pass-boundary entry (drop/undo) is rejected.
  addPass(dir, 'p3', 't3', 400, 500, 10);
  r = runCli(dir, ['drop', '--id', 'p3', '--reason', 'conflict']);
  assert.equal(r.status, 0);
  r = runCli(dir, ['undo', '--to', '3']);
  assert.equal(r.status, 2, 'undo entry is not a pass boundary');

  // Multi-level undo back to the boundary after the p2 add.
  r = runCli(dir, ['undo', '--to', '2']);
  assert.equal(r.status, 0, r.stderr);
  const list = runCli(dir, ['pass', 'list']);
  assert.deepEqual(list.json.passes.map((p) => p.id), ['p1', 'p2']);

  // Confirm p1's scheduled bytes, then undoing the confirm is forbidden.
  r = runCli(dir, ['schedule']);
  assert.equal(r.status, 0);
  r = runCli(dir, ['pass', 'confirm', '--id', 'p1']);
  assert.equal(r.status, 0);
  r = runCli(dir, ['undo', '--steps', '1']);
  assert.equal(r.status, 9, 'undo of confirmed bytes exits 9');
  assert.match(r.stderr, /confirmed bytes/);
  // Multi-level undo that would cross the confirm is also forbidden.
  r = runCli(dir, ['undo', '--to', '0']);
  assert.equal(r.status, 9);
});

test('acceptance 4: verify rejects half-written tail and recovers', () => {
  const dir = tmpDir();
  addPass(dir, 'p1', 't1', 0, 100, 10);
  addPass(dir, 'p2', 't2', 200, 300, 10);
  runCli(dir, ['schedule']);

  const journal = path.join(dir, 'journal.log');
  const good = fs.readFileSync(journal, 'utf8');
  const goodLines = good.trim().split('\n').length;

  // Simulate a crashed append: half-written JSON line.
  fs.appendFileSync(journal, '{"prevHash":"abc","ha');
  let v = runCli(dir, ['verify']);
  assert.equal(v.status, 1, 'verify rejects corrupt tail');
  assert.equal(v.json.ok, false);
  assert.equal(v.json.removed, 1);
  const after = fs.readFileSync(journal, 'utf8');
  assert.equal(after.trim().split('\n').length, goodLines, 'half line truncated');

  // Second verify passes; chain intact.
  v = runCli(dir, ['verify']);
  assert.equal(v.status, 0);
  assert.equal(v.json.ok, true);

  // Tampering with a middle record is also rejected and recovered.
  const lines = after.trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.entry.pass.onboard = 42;
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(journal, lines.join('\n') + '\n');
  v = runCli(dir, ['verify']);
  assert.equal(v.status, 1);
  assert.equal(v.json.entries, 1, 'truncated to last valid record');
  v = runCli(dir, ['verify']);
  assert.equal(v.status, 0);
});

test('schedule output contains second-level timeline and hash certificate', () => {
  const dir = tmpDir();
  addPass(dir, 'p1', 't1', 0, 5, 10);
  const s = runCli(dir, ['schedule']);
  assert.equal(s.status, 0);
  assert.equal(s.json.timeline.length, 5, 'one entry per second');
  assert.deepEqual(s.json.timeline.map((e) => e.sec), [0, 1, 2, 3, 4]);
  assert.ok(/^[0-9a-f]{64}$/.test(s.json.hash), 'sha256 certificate hash');
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  assert.equal(tl.length, 5);
});
