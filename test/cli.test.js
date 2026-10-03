import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// NOTE: this sandbox interferes with grandchild stdio pipes, so the child's
// stdout/stderr are redirected to files and read back.
const run = (args) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-cli-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
};

test('CLI schedule prints the optimal schedule with exit code 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const file = join(dir, 'w.json');
  writeFileSync(file, JSON.stringify({
    tasks: [
      { id: 'a', line: 'L', duration: 2, due: 4 },
      { id: 'b', line: 'L', duration: 2, due: 4 },
    ],
    capacity: { L: [{ start: 0, end: 4, capacity: 1 }] },
  }));
  const res = run(['schedule', '--file', file]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.schedule.status, 'optimal');
  assert.deepEqual(out.schedule.assignments.map((x) => [x.id, x.start]), [['a', 0], ['b', 2]]);
});

test('CLI apply/undo/redo round-trip through a state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const state = join(dir, 'state.json');
  const file = join(dir, 'w.json');
  writeFileSync(file, JSON.stringify({
    tasks: [{ id: 'a', line: 'L', duration: 1, due: 1 }],
  }));

  let res = run(['schedule', '--file', file, '--state', state]);
  assert.equal(res.status, 0, res.stderr);

  res = run(['apply', '--state', state, '--op', JSON.stringify({ op: 'upsertTask', task: { id: 'b', line: 'L', duration: 1, due: 2 } })]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).schedule.assignments.length, 2);

  res = run(['undo', '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).schedule.assignments.length, 1);

  res = run(['redo', '--state', state]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).schedule.assignments.length, 2);
});

test('CLI reports errors on stderr with exit code 1', () => {
  const res = run(['schedule']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /error:/);

  const bad = run(['bogus-command']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command/);
});

test('CLI apply rejects malformed operations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const state = join(dir, 'state.json');
  const res = run(['apply', '--state', state, '--op', '{"op":"removeTask","id":"ghost"}']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown task/);
});
