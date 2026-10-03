import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';

// The CLI is exercised through its exported runCli entry point with captured
// io, which keeps the tests hermetic while running the exact code path the
// `node cli.js ...` process entry uses.

function run(args) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

test('model prints seed, pool, verdict, violation and state hash', () => {
  const res = run(['model', '--seed', '7', '--accounts', '3', '--tasks', '8']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^seed: 7$/m);
  assert.match(res.stdout, /^prng: splitmix64 seed=7 draws=\d+$/m);
  assert.match(res.stdout, /^pool:$/m);
  assert.match(res.stdout, /^  task T0 account=A0 kind=debit amount=63$/m);
  assert.match(res.stdout, /^legalSchedules: 223700400$/m);
  assert.match(res.stdout, /^verdict: VIOLATION$/m);
  assert.match(res.stdout, /^violation: T0\.reserve -> T4\.reserve$/m);
  assert.match(res.stdout, /^stateHash: [0-9a-f]{64}$/m);
});

test('replay reconstructs the identical task pool and search results', () => {
  const model = run(['model', '--seed', '7', '--accounts', '3', '--tasks', '8', '--json']);
  assert.equal(model.code, 0, model.stderr);
  const report = JSON.parse(model.stdout);
  const replay = run([
    'replay', '--seed', '7', '--accounts', '3', '--tasks', '8',
    '--expect-hash', report.stateHash,
  ]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.match(replay.stdout, /replay: OK reconstructed stateHash matches --expect-hash/);
  const replayJson = run(['replay', '--seed', '7', '--accounts', '3', '--tasks', '8', '--json']);
  const replayReport = JSON.parse(replayJson.stdout);
  assert.equal(replayReport.stateHash, report.stateHash);
  assert.deepEqual(replayReport.pool, report.pool);
});

test('replay fails on hash mismatch', () => {
  const res = run([
    'replay', '--seed', '7', '--accounts', '3', '--tasks', '8',
    '--expect-hash', '0'.repeat(64),
  ]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /REPLAY_MISMATCH/);
});

test('check emits an enumeration certificate when all schedules are safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  const file = join(dir, 'safe.json');
  writeFileSync(file, JSON.stringify({
    seed: 101,
    accounts: [{ id: 'A0', limit: 100 }],
    tasks: [
      { id: 'T0', account: 'A0', kind: 'freeze', amount: 10 },
      { id: 'T1', account: 'A0', kind: 'debit', amount: 20 },
    ],
  }));
  const res = run(['check', '--pool', file]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^verdict: SAFE$/m);
  assert.match(res.stdout, /^certificate: all 6 legal schedules keep used\+frozen<=limit across 9 explored states$/m);
  assert.match(res.stdout, /^violation: none$/m);
});

test('check rejects invalid pools with INVALID_MODEL and exit code 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pool-'));
  const cases = [
    { // unknown task target
      accounts: [{ id: 'A0', limit: 100 }],
      tasks: [{ id: 'T0', account: 'A0', kind: 'unfreeze', target: 'T9' }],
    },
    { // duplicate completion
      accounts: [{ id: 'A0', limit: 100 }],
      tasks: [
        { id: 'T0', account: 'A0', kind: 'freeze', amount: 10 },
        { id: 'T1', account: 'A0', kind: 'unfreeze', target: 'T0' },
        { id: 'T2', account: 'A0', kind: 'unfreeze', target: 'T0' },
      ],
    },
    { // over-limit amount
      accounts: [{ id: 'A0', limit: 100 }],
      tasks: [{ id: 'T0', account: 'A0', kind: 'debit', amount: 101 }],
    },
  ];
  for (const [i, pool] of cases.entries()) {
    const file = join(dir, `bad-${i}.json`);
    writeFileSync(file, JSON.stringify(pool));
    const res = run(['check', '--pool', file]);
    assert.equal(res.code, 1, `case ${i} should exit 1`);
    assert.match(res.stderr, /^INVALID_MODEL: /, `case ${i} should report INVALID_MODEL`);
  }
});
