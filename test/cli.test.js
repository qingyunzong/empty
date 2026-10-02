import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { main } from '../bin/sched.js';

function cli(...args) {
  let stdout = '';
  let stderr = '';
  const status = main(args, {
    out: (s) => (stdout += s + '\n'),
    err: (s) => (stderr += s + '\n'),
  });
  return { status, stdout, stderr };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

test('CLI end-to-end: init, commits, schedule, undo, redo, status, verify', () => {
  const d = tmp();
  let r = cli('init', d, '--snapshot-every', '2');
  assert.equal(r.status, 0, r.stderr);

  r = cli('add-machine', d, '--id', 'M1', '--calendar', '[[0,50]]');
  assert.equal(r.status, 0, r.stderr);
  r = cli('add-machine', d, '--id', 'M2', '--calendar', '[[0,50]]');
  assert.equal(r.status, 0, r.stderr);

  const ops1 = JSON.stringify([
    { id: 'a1', machine: 'M1', duration: 4, family: 'A', preds: [] },
    { id: 'a2', machine: 'M2', duration: 3, family: 'B', preds: ['a1'] },
  ]);
  const ops2 = JSON.stringify([{ id: 'b1', machine: 'M1', duration: 2, family: 'B', preds: [] }]);
  r = cli('add-order', d, '--id', 'W1', '--priority', '3', '--ops', ops1);
  assert.equal(r.status, 0, r.stderr);
  r = cli('add-order', d, '--id', 'W2', '--priority', '1', '--ops', ops2);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-setup', d, '--machine', 'M1', '--from', 'A', '--to', 'B', '--time', '2');
  assert.equal(r.status, 0, r.stderr);

  r = cli('schedule', d, '--budget', '50');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.schedule.assignments.length, 3);

  const scheduled = JSON.parse(cli('status', d).stdout);
  r = cli('undo', d);
  assert.equal(r.status, 0, r.stderr);
  r = cli('redo', d);
  assert.equal(r.status, 0, r.stderr);
  const afterRedo = JSON.parse(cli('status', d).stdout);
  assert.equal(afterRedo.stateHash, scheduled.stateHash);

  r = cli('verify', d);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('CLI exit codes: E_BUDGET, E_PRECEDENCE, E_CRC, E_DIVERGED', () => {
  const d = tmp();
  cli('init', d);
  cli('add-machine', d, '--id', 'M1', '--calendar', '[[0,10]]');
  const ops = JSON.stringify([{ id: 'a', machine: 'M1', duration: 5, family: 'A', preds: [] }]);
  cli('add-order', d, '--id', 'W1', '--priority', '1', '--ops', ops);

  let r = cli('schedule', d, '--budget', '4');
  assert.equal(r.status, 10);
  assert.match(r.stderr, /E_BUDGET/);

  const cyclic = JSON.stringify([
    { id: 'x', machine: 'M1', duration: 1, family: 'A', preds: ['y'] },
    { id: 'y', machine: 'M1', duration: 1, family: 'A', preds: ['x'] },
  ]);
  r = cli('add-order', d, '--id', 'BAD', '--ops', cyclic);
  assert.equal(r.status, 11);
  assert.match(r.stderr, /E_PRECEDENCE/);

  r = cli('redo', d);
  assert.equal(r.status, 13);
  assert.match(r.stderr, /E_DIVERGED/);

  // Corrupt a non-tail chunk -> E_CRC on verify.
  const logPath = path.join(d, 'log.dat');
  const buf = fs.readFileSync(logPath);
  buf[2] = buf[2] === 0x61 ? 0x62 : 0x61;
  fs.writeFileSync(logPath, buf);
  r = cli('verify', d);
  assert.equal(r.status, 12);
  assert.match(r.stderr, /E_CRC/);
});
