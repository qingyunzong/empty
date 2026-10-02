import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliMain } from '../cli.js';

// In-process CLI runner: the sandbox forbids spawning child processes from
// tests, so cli.js exposes cliMain(argv, io) and we capture output directly.
function run(args) {
  let stdout = '';
  let stderr = '';
  const code = cliMain(args, { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

function writeJson(dir, name, obj) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

const feasibleInput = {
  horizon: 12,
  tanks: [{ id: 'T1', capacity: 100, materials: ['A'] }],
  tasks: [
    { id: 'J1', material: 'A', minCapacity: 10, maxCapacity: 100, duration: 2, deadline: 12 },
    { id: 'J2', material: 'A', minCapacity: 10, maxCapacity: 100, duration: 2, deadline: 12 },
  ],
};

test('cli assign: feasible input exits 0 with an assignment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const file = writeJson(dir, 'ok.json', feasibleInput);
  const r = run(['assign', file]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'feasible');
  assert.ok(out.assignment.J1 && out.assignment.J2);
});

test('cli assign: illegal time -> exit code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const bad = { ...feasibleInput, tasks: [{ ...feasibleInput.tasks[0], earliestStart: -1 }] };
  const file = writeJson(dir, 'bad-time.json', bad);
  const r = run(['assign', file]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /earliestStart/);
});

test('cli assign: illegal tank capacity window -> exit code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const bad = {
    ...feasibleInput,
    tasks: [{ ...feasibleInput.tasks[0], minCapacity: 200, maxCapacity: 100 }],
  };
  const file = writeJson(dir, 'bad-cap.json', bad);
  const r = run(['assign', file]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /maxCapacity/);
});

test('cli assign: tiny budget -> unknown with pending tasks, exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const file = writeJson(dir, 'budget.json', feasibleInput);
  const r = run(['assign', file, '--budget', '0']);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'unknown');
  assert.deepEqual([...out.pending].sort(), ['J1', 'J2']);
});

test('cli hold/release: hold persists, failed hold rolls back, release restores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const file = writeJson(dir, 'flow.json', feasibleInput);
  const stateFile = `${file}.state.json`;

  // A hold that still leaves room: occupies [0,8), tasks fit in [8,12).
  let r = run(['hold', file, '--tank', 'T1', '--start', '0', '--duration', '8', '--label', 'wash']);
  assert.equal(r.code, 0, r.stderr);
  const held = JSON.parse(r.stdout);
  assert.equal(held.status, 'held');
  assert.equal(held.hold.id, 'H1');
  assert.ok(existsSync(stateFile));

  // Assign with the hold active: still feasible.
  r = run(['assign', file]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).status, 'feasible');

  // A hold that overlaps the remaining window makes the problem infeasible
  // and must be rolled back (state keeps only H1).
  r = run(['hold', file, '--tank', 'T1', '--start', '8', '--duration', '4']);
  assert.equal(r.code, 1);
  const failed = JSON.parse(r.stdout);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'infeasible');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.holds.length, 1, 'failed hold must be rolled back');
  assert.equal(state.holds[0].id, 'H1');

  // Release by label, then the schedule is feasible without holds.
  r = run(['release', file, '--id', 'wash']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).status, 'released');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).holds.length, 0);

  r = run(['assign', file]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).status, 'feasible');

  // Releasing an unknown hold fails with exit 1.
  r = run(['release', file, '--id', 'nope']);
  assert.equal(r.code, 1);
});

test('cli hold: illegal hold time -> exit code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-'));
  const file = writeJson(dir, 'hold-bad.json', feasibleInput);
  const r = run(['hold', file, '--tank', 'T1', '--start', '1.5', '--duration', '2']);
  assert.equal(r.code, 2);
});
