import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir, runCli, makePack, copyPack } from '../testing/helpers.js';

test('acceptance 4: write from old-epoch member is rejected with STALE_EPOCH (exit 5)', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  makePack(A, 3);
  const B = copyPack(A, path.join(dir, 'B'));

  // membership change on A: epoch barrier goes up
  const e = runCli(['epoch', A, '--members', 'x,y,z']);
  assert.equal(e.status, 0);
  assert.equal(e.json.epoch, 2);

  // B (still epoch 1) keeps writing
  const add = runCli(['add', B, '--data', '{"late":true}']);
  assert.equal(add.status, 0);
  assert.equal(add.json.epoch, 1);

  // anti-entropy: A refuses B's stale-epoch block
  const s = runCli(['sync', A, B]);
  assert.equal(s.status, 5, `expected exit 5, got ${s.status}: ${s.stderr}`);
  assert.equal(s.errJson.error.code, 'STALE_EPOCH');
  assert.equal(s.errJson.error.epoch, 2);
  assert.equal(s.errJson.error.blockEpoch, 1);

  // A did not adopt the stale block
  assert.equal(runCli(['digest', A]).json.length, 3);
  assert.equal(runCli(['verify', A]).status, 0);
});

test('old-epoch blocks stay readable after the barrier', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  makePack(A, 3);
  runCli(['epoch', A, '--members', 'x,y']);
  // old blocks: verify + prove still work
  assert.equal(runCli(['verify', A]).status, 0);
  const p = runCli(['prove', A, '--index', '1']);
  assert.equal(p.status, 0);
  assert.equal(p.json.epoch, 1);
  // new writes land in the new epoch
  const add = runCli(['add', A, '--data', '{"after":true}']);
  assert.equal(add.json.epoch, 2);
  assert.equal(runCli(['verify', A]).status, 0);
});

test('epoch propagates through sync handshake', () => {
  const dir = tmpdir();
  const A = path.join(dir, 'A');
  makePack(A, 2);
  const B = copyPack(A, path.join(dir, 'B'));
  runCli(['epoch', A, '--members', 'x,y,z']);
  const addA = runCli(['add', A, '--data', '{"e":2}']);
  assert.equal(addA.json.epoch, 2);
  const s = runCli(['sync', A, B]);
  assert.equal(s.status, 0);
  assert.equal(s.json.epoch, 2);
  assert.equal(runCli(['digest', B]).json.epoch, 2);
  assert.deepEqual(runCli(['digest', B]).json.members, ['x', 'y', 'z']);
  // B now writes in epoch 2 as well
  const addB = runCli(['add', B, '--data', '{"from":"B"}']);
  assert.equal(addB.json.epoch, 2);
});
