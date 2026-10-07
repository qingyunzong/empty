// Acceptance 2: scrap is a tombstone; rework must not revive a scrapped defect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir, runCli, runOk, readState } from '../test-utils/helpers.js';

test('scrapped defect cannot be revived by rework, reopen, or undo', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1', 'cracked-housing']);
  const scrap = runOk(dir, ['scrap', 'D1']);

  const rework = runCli(dir, ['rework', 'R1', 'D1']);
  assert.equal(rework.status, 1);
  assert.match(rework.stderr, /tombstone/);

  const reopen = runCli(dir, ['open', 'D1', 'again']);
  assert.equal(reopen.status, 1);
  assert.match(reopen.stderr, /tombstone/);

  const undo = runCli(dir, ['undo', String(scrap.seq)]);
  assert.equal(undo.status, 21, 'undo of a terminal tombstone is a closed-loop undo');

  const state = readState(dir);
  assert.equal(state.defects.D1.status, 'scrapped');
  assert.ok(state.tombstones.D1, 'tombstone recorded');
  assert.equal(state.orders.R1, undefined, 'no rework order was created');
  assert.equal(runCli(dir, ['verify']).status, 0);
});

test('scrap mixed with healthy flow: other defects unaffected', () => {
  const dir = tmpDir();
  runOk(dir, ['open', 'D1']);
  runOk(dir, ['open', 'D2']);
  runOk(dir, ['scrap', 'D1']);
  runOk(dir, ['rework', 'R1', 'D2']);
  runOk(dir, ['inspect', 'R1', '0', 'pass']);
  runOk(dir, ['close', 'R1']);
  const state = readState(dir);
  assert.equal(state.defects.D1.status, 'scrapped');
  assert.equal(state.defects.D2.status, 'closed');
  assert.equal(runCli(dir, ['verify']).status, 0);
});
