import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, EXIT_CODES } from '../src/cli.js';

function makeDir(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-cli-'));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, null, 2));
  return dir;
}

function cli(args) {
  const out = { stdout: '', stderr: '' };
  const status = run(args, {
    stdout: (s) => { out.stdout += s; },
    stderr: (s) => { out.stderr += s; },
  });
  return { status, ...out };
}

const input = {
  capacity: 100,
  agingLimit: 1,
  agingBonus: 1,
  institutions: { alpha: { quota: 70 }, beta: { quota: 60 } },
  batches: [
    { id: 'a1', institution: 'alpha', amount: 40, priority: 3, group: 'g1' },
    { id: 'a2', institution: 'beta', amount: 30, priority: 3, group: 'g1' },
    { id: 'b1', institution: 'alpha', amount: 50, priority: 9 },
    { id: 'b2', institution: 'beta', amount: 80, priority: 2, splittable: true },
    { id: 'b3', institution: 'alpha', amount: 20, priority: 1 },
  ],
};

test('plan prints rounds, waits and proof without writing anything', () => {
  const dir = makeDir(input);
  const res = cli(['plan', '--data', dir]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.command, 'plan');
  assert.ok(Array.isArray(out.rounds) && out.rounds.length >= 1);
  assert.ok(out.waits && typeof out.waits === 'object');
  assert.match(out.proof, /^[0-9a-f]{64}$/);
  assert.ok(!fs.existsSync(path.join(dir, 'rounds')), 'plan is read-only');
});

test('commit persists rounds one at a time; verify passes; recover is a no-op', () => {
  const dir = makeDir(input);
  const c1 = JSON.parse(cli(['commit', '--data', dir]).stdout);
  assert.equal(c1.committed.index, 1);
  const c2 = JSON.parse(cli(['commit', '--data', dir]).stdout);
  assert.equal(c2.committed.index, 2);
  assert.notEqual(c1.proof, c2.proof);
  const v = cli(['verify', '--data', dir]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(JSON.parse(v.stdout).ok, true);
  const rec = JSON.parse(cli(['recover', '--data', dir]).stdout);
  assert.equal(rec.code, 'OK');
  assert.deepEqual(rec.rolledBack, []);
});

test('recover rolls back a partial commit and reports PARTIAL_COMMIT', () => {
  const dir = makeDir(input);
  cli(['commit', '--data', dir]);
  const rd = path.join(dir, 'rounds', 'round-000002');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'round.json'), JSON.stringify({ index: 2, allocations: [], used: 0, proof: 'x' }));
  const rec = cli(['recover', '--data', dir]);
  assert.equal(rec.status, 0, rec.stderr);
  const out = JSON.parse(rec.stdout);
  assert.equal(out.code, 'PARTIAL_COMMIT');
  assert.deepEqual(out.rolledBack, ['round-000002']);
  assert.ok(!fs.existsSync(rd));
  const v = cli(['verify', '--data', dir]);
  assert.equal(v.status, 0, v.stderr);
});

test('verify fails with PARTIAL_COMMIT after tampering', () => {
  const dir = makeDir(input);
  cli(['commit', '--data', dir]);
  const file = path.join(dir, 'rounds', 'round-000001', 'round.json');
  const round = JSON.parse(fs.readFileSync(file, 'utf8'));
  round.used += 1;
  fs.writeFileSync(file, JSON.stringify(round, null, 2));
  const v = cli(['verify', '--data', dir]);
  assert.equal(v.status, EXIT_CODES.PARTIAL_COMMIT);
  assert.equal(JSON.parse(v.stderr).error, 'PARTIAL_COMMIT');
});

test('error codes: ATOMIC_SPLIT=2, WINDOW_FULL=3, QUOTA=4', () => {
  const split = makeDir({
    capacity: 10,
    institutions: { A: { quota: 10 } },
    batches: [
      { id: 'x', institution: 'A', amount: 6, priority: 1, group: 'g' },
      { id: 'y', institution: 'A', amount: 6, priority: 1, group: 'g' },
    ],
  });
  const r1 = cli(['plan', '--data', split]);
  assert.equal(r1.status, EXIT_CODES.ATOMIC_SPLIT);
  assert.equal(JSON.parse(r1.stderr).error, 'ATOMIC_SPLIT');

  const full = makeDir({
    capacity: 10,
    institutions: { A: { quota: 100 } },
    batches: [{ id: 'x', institution: 'A', amount: 11, priority: 1 }],
  });
  const r2 = cli(['plan', '--data', full]);
  assert.equal(r2.status, EXIT_CODES.WINDOW_FULL);
  assert.equal(JSON.parse(r2.stderr).error, 'WINDOW_FULL');

  const quota = makeDir({
    capacity: 10,
    institutions: { A: { quota: 0 } },
    batches: [{ id: 'x', institution: 'A', amount: 1, priority: 1 }],
  });
  const r3 = cli(['plan', '--data', quota]);
  assert.equal(r3.status, EXIT_CODES.QUOTA);
  assert.equal(JSON.parse(r3.stderr).error, 'QUOTA');
});

test('commit on drained queue reports nothing to do', () => {
  const dir = makeDir({
    capacity: 10,
    institutions: { A: { quota: 10 } },
    batches: [{ id: 'x', institution: 'A', amount: 5, priority: 1 }],
  });
  cli(['commit', '--data', dir]);
  const res = cli(['commit', '--data', dir]);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).committed, null);
});
