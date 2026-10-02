import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, runCli } from './helpers.js';

function statusRecords(dir) {
  const r = runCli(['--store', dir, 'status']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).records;
}

function batch(prefix) {
  return `{"key":"${prefix}1","value":1}\n{"key":"${prefix}2","value":2}\n`;
}

// A batch is written as prepare + fsync + commit + fsync. Killing the process
// at any point must leave the batch either fully visible or fully invisible —
// never partially applied.
test('acceptance 4: kill around fsync leaves the batch fully visible or not at all', () => {
  const dir = tmpdir();
  let r = runCli(['--store', dir, 'init', '--node', 'A', '--nodes', 'A']);
  assert.equal(r.status, 0, r.stderr);

  // Kill after the prepare write but before its fsync: no commit record can
  // exist, so the batch must be invisible after recovery.
  r = runCli(['--store', dir, 'put'], { input: batch('a'), env: { OBS_FAULT: 'before-prepare-fsync' } });
  assert.notEqual(r.status, 0);
  assert.equal(statusRecords(dir), 0, 'killed before prepare fsync: batch must be invisible');

  // Kill after the prepare fsync but before the commit write: the prepare is
  // durable yet uncommitted, and recovery must ignore it.
  r = runCli(['--store', dir, 'put'], { input: batch('b'), env: { OBS_FAULT: 'before-commit-write' } });
  assert.notEqual(r.status, 0);
  assert.equal(statusRecords(dir), 0, 'uncommitted prepare must be ignored on recovery');

  // Kill after the commit write but before its fsync: the commit record
  // already reached the OS, so the whole batch is visible after recovery.
  // (A power loss instead of a process kill could legitimately lose it —
  // both outcomes satisfy all-or-nothing.)
  r = runCli(['--store', dir, 'put'], { input: batch('c'), env: { OBS_FAULT: 'before-commit-fsync' } });
  assert.notEqual(r.status, 0);
  assert.equal(statusRecords(dir), 2, 'committed batch must be fully visible, never partial');

  // Kill after the commit fsync: fully durable.
  r = runCli(['--store', dir, 'put'], { input: batch('d'), env: { OBS_FAULT: 'after-commit-fsync' } });
  assert.notEqual(r.status, 0);
  assert.equal(statusRecords(dir), 4, 'fsynced batch must survive the crash');

  // A clean run afterwards still works and appends to the same log.
  r = runCli(['--store', dir, 'put'], { input: '{"key":"e1","value":3}\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statusRecords(dir), 5);

  // Keys from crashed batches are individually queryable: all-or-nothing.
  const detail = runCli(['--store', dir, 'status', '--key', 'c1']);
  assert.equal(JSON.parse(detail.stdout).value, 1);
  const missing = runCli(['--store', dir, 'status', '--key', 'a1']);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stderr.trim()).code, 'NOT_FOUND');
});

test('invalid input aborts the whole batch before anything is written', () => {
  const dir = tmpdir();
  runCli(['--store', dir, 'init', '--node', 'A']);
  const r = runCli(['--store', dir, 'put'], { input: '{"key":"ok","value":1}\nnot-json\n' });
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'BAD_INPUT');
  assert.equal(statusRecords(dir), 0, 'no partial batch may be committed');
});
