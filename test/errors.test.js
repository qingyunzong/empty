// Error contract: exit 21 (undo after closed loop), 22 (WAL checksum), 23 (hash mismatch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, runCli, runOk, readState } from '../test-utils/helpers.js';

test('exit 21: undo of any node in a closed loop is rejected', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  runOk(dir, ['rework', 'R1', 'D1']);
  runOk(dir, ['inspect', 'R1', '0', 'pass']);
  const close = runOk(dir, ['close', 'R1']);

  assert.equal(runCli(dir, ['undo', String(close.seq)]).status, 21, 'undo close');
  assert.equal(runCli(dir, ['undo', '1']).status, 21, 'undo open of now-closed defect');
  assert.equal(runCli(dir, ['undo', '2']).status, 21, 'undo rework of now-closed order');
  assert.equal(runCli(dir, ['undo', '3']).status, 21, 'undo inspect of now-closed order');
  assert.equal(runCli(dir, ['verify']).status, 0);
});

test('exit 22: WAL checksum failure', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1', 'original-desc']);
  const walFile = path.join(dir, 'wal.log');
  const wal = fs.readFileSync(walFile, 'utf8');
  fs.writeFileSync(walFile, wal.replace('original-desc', 'tampered-desc'));

  assert.match(runCli(dir, ['verify']).stderr, /checksum/);
  assert.equal(runCli(dir, ['verify']).status, 22);
  assert.equal(runCli(dir, ['crash-recover']).status, 22);
});

test('exit 23: state hash mismatch before/after recovery', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  const snapFile = path.join(dir, 'snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  snap.state.defects.D1.status = 'closed'; // corrupt the snapshot
  fs.writeFileSync(snapFile, JSON.stringify(snap));

  assert.equal(runCli(dir, ['verify']).status, 23);
  assert.equal(runCli(dir, ['crash-recover']).status, 23);
});

test('undo of a non-closed node succeeds and leaves an audit trail', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  runOk(dir, ['open', 'D2']);
  const undo = runOk(dir, ['undo', '2']);
  const state = readState(dir);
  assert.equal(state.defects.D2, undefined, 'undone defect is gone');
  assert.equal(state.defects.D1.status, 'open', 'other defect untouched');
  assert.deepEqual(state.audit, [{ seq: undo.seq, undoOf: 2, op: 'open' }], 'audit trail recorded');
  assert.equal(runCli(dir, ['verify']).status, 0);
});
