import test from 'node:test';
import assert from 'node:assert/strict';
import { Txn, TxnError } from '../src/txn.js';
import { tmpdir, runCli, writeScript } from '../support/helpers.js';

const ENV = {
  lines: [{ name: 'A', shifts: [[480, 960]], maintenance: [] }, { name: 'B', shifts: [[480, 960]], maintenance: [] }],
  constraints: [],
};

test('nested savepoints: rollback removes later savepoints, keeps earlier ones', () => {
  const txn = new Txn([]);
  txn.addJob({ id: 'J1', duration: 30, priority: 1, lines: null });
  txn.savepoint('s1');
  txn.addJob({ id: 'J2', duration: 30, priority: 2, lines: null });
  txn.savepoint('s2');
  txn.addJob({ id: 'J3', duration: 30, priority: 3, lines: null });
  txn.savepoint('s3');
  txn.moveJob('J1', 'B');

  txn.rollback('s2');
  // state back to s2: J1, J2 present; J3 gone; J1 not moved
  assert.deepEqual(txn.jobList().map((j) => j.id).sort(), ['J1', 'J2']);
  assert.equal(txn.jobs.get('J1').lines, null);
  // s3 removed; s1 and s2 still valid
  assert.deepEqual(txn.savepoints.map((s) => s.name), ['s1', 's2']);

  // earlier savepoint still valid after a rollback
  txn.addJob({ id: 'J4', duration: 30, priority: 4, lines: null });
  txn.rollback('s1');
  assert.deepEqual(txn.jobList().map((j) => j.id), ['J1']);
  assert.deepEqual(txn.savepoints.map((s) => s.name), ['s1']);
});

test('rollback to unknown savepoint fails', () => {
  const txn = new Txn([]);
  txn.savepoint('s1');
  assert.throws(() => txn.rollback('nope'), TxnError);
});

test('duplicate add-job and unknown move-job fail', () => {
  const txn = new Txn([]);
  txn.addJob({ id: 'J1', duration: 30, priority: 1, lines: null });
  assert.throws(() => txn.addJob({ id: 'J1', duration: 30, priority: 1, lines: null }), TxnError);
  assert.throws(() => txn.moveJob('ghost', 'A'), TxnError);
});

test('end-to-end nested rollback through the CLI with persistence', () => {
  const dir = tmpdir();
  assert.equal(runCli(['init', dir]).code, 0);
  const script = `
line A
line B
calendar A { shift 08:00-16:00 }
calendar B { shift 08:00-16:00 }
job J1 { duration 30m priority 1 }
commit
savepoint s1
add-job J2 { duration 30m priority 2 }
savepoint s2
add-job J3 { duration 30m priority 3 }
savepoint s3
move-job J1 B
rollback s2
commit
`;
  const r = runCli(['apply', dir, writeScript(dir, script)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /COMMITTED gen=1 jobs=1/);
  assert.match(r.stdout, /COMMITTED gen=2 jobs=2/);
  const out = runCli(['export', dir]);
  assert.equal(out.code, 0);
  const plan = JSON.parse(out.stdout);
  assert.equal(plan.generation, 2);
  assert.deepEqual(plan.jobs.map((j) => j.id).sort(), ['J1', 'J2']);
  // J1 was moved to B after s2 but the move was rolled back -> stays on A
  assert.equal(plan.jobs.find((j) => j.id === 'J1').line, 'A');
});

test('uncommitted transaction is discarded (no commit in script)', () => {
  const dir = tmpdir();
  runCli(['init', dir]);
  const script = `
line A
calendar A { shift 08:00-16:00 }
job J1 { duration 30m priority 1 }
`;
  const r = runCli(['apply', dir, writeScript(dir, script)]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /UNCOMMITTED/);
  const rec = runCli(['recover', dir]);
  assert.match(rec.stdout, /RECOVERED gen=0 jobs=0/);
});
