import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, runCli, writeScenario } from './helpers.js';

const scenario = {
  capacity: 10,
  agingLimit: 2,
  institutions: { A: { quota: 7 }, B: { quota: 6 } },
  batches: [
    { id: 'a1', institution: 'A', priority: 3, amount: 9 },
    { id: 'a2', institution: 'A', priority: 1, amount: 5 },
    { id: 'g1a', institution: 'B', priority: 2, amount: 3, group: 'g1' },
    { id: 'g1b', institution: 'B', priority: 2, amount: 3, group: 'g1' },
    { id: 'b2', institution: 'B', priority: 0, amount: 8 },
  ],
};

function plan(dir) {
  const input = writeScenario(dir, scenario);
  const r = runCli(['plan', '--input', input, '--state', dir]);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

test('plan -> commit -> verify lifecycle with stable proof', () => {
  const dir = tmpDir();
  const planned = plan(dir);
  assert.equal(planned.rounds.length, 3);
  const commit = runCli(['commit', '--state', dir]);
  assert.equal(commit.status, 0, commit.stderr);
  const verify = runCli(['verify', '--state', dir]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.json.ok, true);
  assert.equal(verify.json.proof, planned.proof);
  assert.deepEqual(verify.json.waits, planned.waits);
});

test('crash after writing round dir rolls back the whole round', () => {
  const dir = tmpDir();
  const planned = plan(dir);

  const crash = runCli(['commit', '--state', dir, '--rounds', '2', '--crash-after-write']);
  assert.equal(crash.status, 3);
  assert.equal(crash.json.crashed, true);
  assert.equal(crash.json.round, 2);
  assert.ok(fs.existsSync(path.join(dir, 'rounds', 'round-0002', 'allocations.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'rounds', 'round-0002', 'commit.marker')));

  const badVerify = runCli(['verify', '--state', dir]);
  assert.equal(badVerify.status, 13);
  assert.ok(badVerify.stderr.includes('PARTIAL_COMMIT'));

  const recover = runCli(['recover', '--state', dir]);
  assert.equal(recover.status, 0, recover.stderr);
  assert.deepEqual(recover.json.rolledBack, ['round-0002']);
  assert.ok(!fs.existsSync(path.join(dir, 'rounds', 'round-0002')));
  assert.equal(recover.json.rounds.length, 1);

  const recoverAgain = runCli(['recover', '--state', dir]);
  assert.equal(recoverAgain.status, 0);
  assert.deepEqual(recoverAgain.json.rolledBack, []);
  assert.equal(recoverAgain.json.proof, recover.json.proof);

  const commit = runCli(['commit', '--state', dir]);
  assert.equal(commit.status, 0, commit.stderr);
  const verify = runCli(['verify', '--state', dir]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.json.proof, planned.proof);
  assert.equal(verify.json.rounds.length, 3);
});

test('commit before plan fails cleanly', () => {
  const dir = tmpDir();
  const r = runCli(['commit', '--state', dir]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('no plan'));
});
