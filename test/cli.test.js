import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// NOTE: this sandbox cannot pipe stdout between node processes, so the
// child's stdout/stderr are captured through temporary files instead.
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-io-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return {
    code: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

function fixture(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

const feasibleInput = {
  horizon: 40,
  tanks: [
    { id: 'T1', material: 'steel', capacity: 500 },
    { id: 'T2', material: 'glass', capacity: 300 },
  ],
  compatibility: { X: ['steel', 'glass'], Y: ['steel'] },
  cleaning: [
    { from: 'X', to: 'Y', time: 5 },
    { from: 'Y', to: 'X', time: 5 },
  ],
  tasks: [
    { id: 'A', material: 'X', minCapacity: 100, maxCapacity: 600, earliestStart: 0, latestStart: 20, duration: 10 },
    { id: 'B', material: 'Y', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 20, duration: 8 },
    { id: 'C', material: 'X', minCapacity: 200, maxCapacity: 500, earliestStart: 5, latestStart: 25, duration: 12 },
  ],
};

const conflictInput = {
  horizon: 40,
  tanks: [{ id: 'T1', material: 'steel', capacity: 500 }],
  compatibility: { X: ['steel'], Y: ['steel'] },
  cleaning: [
    { from: 'X', to: 'Y', time: 15 },
    { from: 'Y', to: 'X', time: 15 },
  ],
  tasks: [
    { id: 'L', material: 'X', minCapacity: 100, maxCapacity: 500, earliestStart: 0, duration: 10, locked: true, tank: 'T1', start: 0 },
    { id: 'B', material: 'Y', minCapacity: 100, maxCapacity: 500, earliestStart: 0, latestStart: 20, duration: 10 },
  ],
};

test('assign: feasible problem exits 0 with valid assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-'));
  const input = fixture(dir, 'feasible.json', feasibleInput);
  const res = run(['assign', input]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'feasible');
  assert.equal(out.assignments.length, 3);
  const byTask = Object.fromEntries(out.assignments.map((a) => [a.task, a]));
  // B (material Y) can only go on steel T1.
  assert.equal(byTask.B.tank, 'T1');
  for (const a of out.assignments) {
    assert.ok(Number.isInteger(a.start) && a.end === a.start + feasibleInput.tasks.find((t) => t.id === a.task).duration);
  }
});

test('assign: locked task conflict exits 1 with minimal conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-'));
  const input = fixture(dir, 'conflict.json', conflictInput);
  const res = run(['assign', input]);
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'infeasible');
  assert.deepEqual([...out.conflict.tasks].sort(), ['B', 'L']);
  assert.deepEqual(out.conflict.tanks, ['T1']);
  assert.equal(out.conflict.cleaning.length, 2);
});

test('tiny budget is unknown; release then re-solve is feasible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-'));
  const input = fixture(dir, 'budget.json', feasibleInput);

  const unknown = run(['assign', input, '--budget', '0']);
  assert.equal(unknown.code, 3, unknown.stderr);
  const unknownOut = JSON.parse(unknown.stdout);
  assert.equal(unknownOut.status, 'unknown');
  assert.deepEqual([...unknownOut.pending].sort(), ['A', 'B', 'C']);

  const hold = run(['hold', input, '--id', 'H1', '--tank', 'T2', '--start', '0', '--duration', '4', '--material', 'X']);
  assert.equal(hold.code, 0, hold.stderr);
  assert.equal(JSON.parse(hold.stdout).status, 'held');
  assert.ok(existsSync(`${input}.state.json`));

  const stillUnknown = run(['assign', input, '--budget', '0']);
  assert.equal(stillUnknown.code, 3);
  assert.equal(JSON.parse(stillUnknown.stdout).status, 'unknown');

  const release = run(['release', input, '--id', 'H1']);
  assert.equal(release.code, 0, release.stderr);
  const state = JSON.parse(readFileSync(`${input}.state.json`, 'utf8'));
  assert.deepEqual(state.holds, []);

  const solved = run(['assign', input]);
  assert.equal(solved.code, 0, solved.stderr);
  assert.equal(JSON.parse(solved.stdout).status, 'feasible');
});

test('hold that violates cleaning fails and leaves no state behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-'));
  const input = fixture(dir, 'holdfail.json', conflictInput);
  const res = run(['hold', input, '--id', 'H9', '--tank', 'T1', '--start', '10', '--duration', '5', '--material', 'Y']);
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stdout).status, 'hold_failed');
  assert.ok(!existsSync(`${input}.state.json`));
});

test('illegal time or capacity exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tank-sched-'));
  const cases = {
    'zero-duration.json': { ...feasibleInput, tasks: [{ ...feasibleInput.tasks[0], duration: 0 }] },
    'negative-start.json': { ...feasibleInput, tasks: [{ ...feasibleInput.tasks[0], earliestStart: -1 }] },
    'bad-capacity-range.json': { ...feasibleInput, tasks: [{ ...feasibleInput.tasks[0], minCapacity: 600, maxCapacity: 100 }] },
    'bad-tank-capacity.json': { ...feasibleInput, tanks: [{ id: 'T1', material: 'steel', capacity: -5 }] },
    'bad-horizon.json': { ...feasibleInput, horizon: 0 },
  };
  for (const [name, value] of Object.entries(cases)) {
    const input = fixture(dir, name, value);
    const res = run(['assign', input]);
    assert.equal(res.code, 2, `${name}: expected exit 2, got ${res.code} (${res.stdout}${res.stderr})`);
    assert.match(res.stderr, /invalid input/);
  }
  // Illegal hold parameters also exit 2.
  const okInput = fixture(dir, 'ok.json', feasibleInput);
  const badHold = run(['hold', okInput, '--id', 'H', '--tank', 'T1', '--start', 'x', '--duration', '5']);
  assert.equal(badHold.code, 2);
});
