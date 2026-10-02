import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir, runCli, writeScript, BIN } from '../support/helpers.js';

function runCliSh(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('init / apply / export: feasible plan with tied priorities', () => {
  const dir = tmpdir();
  let r = runCli(['init', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /OK/);

  const script = `
line A
line B
calendar A { shift 08:00-12:00 shift 13:00-17:00 }
calendar B { shift 09:00-17:00 }
maintenance A @2026-01-02T10:00 for 1h
template t(p) { duration 30m priority p }
job J1 = t(5)
job J2 = t(5)
job J3 = t(5)
add-job J4 { duration 1h priority 9 lines B }
constraint cap = count(A) <= 3 && load(B) <= 8h
commit
`;
  r = runCli(['apply', dir, writeScript(dir, script)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /COMMITTED gen=1 jobs=4/);

  r = runCli(['export', dir]);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.generation, 1);
  assert.equal(plan.jobs.length, 4);
  // tied priorities: J1, J2, J3 (all priority 5) ordered by id on line A
  const tied = plan.jobs.filter((j) => j.priority === 5);
  assert.deepEqual(tied.map((j) => j.id), ['J1', 'J2', 'J3']);
  const starts = tied.map((j) => j.start);
  assert.deepEqual([...starts].sort(), starts); // J1 < J2 < J3 in time
  assert.equal(plan.jobs.find((j) => j.id === 'J4').line, 'B');
  // export is deterministic across runs
  const r2 = runCli(['export', dir]);
  assert.equal(r2.stdout, r.stdout);
});

test('infeasible plan -> INFEASIBLE on stdout, exit 2, nothing persisted', () => {
  const dir = tmpdir();
  runCli(['init', dir]);
  const script = `
line A
calendar A { shift 08:00-12:00 }
job J1 { duration 10h priority 1 }
commit
`;
  const r = runCli(['apply', dir, writeScript(dir, script)]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /INFEASIBLE/);
  const rec = runCli(['recover', dir]);
  assert.match(rec.stdout, /RECOVERED gen=0 jobs=0/);
});

test('constraint violation -> INFEASIBLE, exit 2', () => {
  const dir = tmpdir();
  runCli(['init', dir]);
  const script = `
line A
calendar A { shift 08:00-16:00 }
constraint none = count(A) <= 0
job J1 { duration 30m priority 1 lines A }
commit
`;
  const r = runCli(['apply', dir, writeScript(dir, script)]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /INFEASIBLE/);
});

test('parse error and type error -> exit 1', () => {
  const dir = tmpdir();
  runCli(['init', dir]);
  let r = runCli(['apply', dir, writeScript(dir, 'line { oops')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ERROR/);
  r = runCli(['apply', dir, writeScript(dir, 'line A\nconstraint c = count(A) <= 8h\ncommit')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ERROR/);
});

test('apply reads script from stdin with -', () => {
  const dir = tmpdir();
  runCli(['init', dir]);
  const script = writeScript(dir,
    'line A\ncalendar A { shift 08:00-16:00 }\njob J1 { duration 30m priority 1 }\ncommit\n');
  // pipe via shell redirection (spawnSync input pipes hang in some sandboxes)
  const r = runCliSh(`"${process.execPath}" "${BIN}" apply "${dir}" - < "${script}"`);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /COMMITTED gen=1 jobs=1/);
});

test('usage error -> exit 1', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.code, 1);
});
