import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mold-sched.js');
const tmp = mkdtempSync(join(tmpdir(), 'mold-sched-'));

// In-process CLI invocation with captured streams.
function run(args, stdinText) {
  const cap = { out: '', err: '' };
  const io = {
    readStdin: () => stdinText ?? '',
    writeOut: (s) => { cap.out += s; },
    writeErr: (s) => { cap.err += s; },
  };
  const code = runCli(args, io);
  return { code, stdout: cap.out, stderr: cap.err };
}

const feasibleInstance = {
  machines: ['M1', 'M2'],
  shifts: [{ id: 'S1', start: 0, end: 10, quotas: { A: 10 } }],
  orders: [
    { id: 'J1', release: 0, duration: 3, deadline: 6, family: 'A', priority: 'normal', machines: ['M1', 'M2'] },
    { id: 'J2', release: 1, duration: 2, deadline: 5, family: 'A', priority: 'critical', machines: ['M1'] },
  ],
};

test('solve prints an optimal solution with certificate and exits 0', () => {
  const file = join(tmp, 'inst.json');
  writeFileSync(file, JSON.stringify(feasibleInstance));
  const r = run(['solve', file]);
  assert.equal(r.code, 0, r.stderr);
  const sol = JSON.parse(r.stdout);
  assert.equal(sol.status, 'optimal');
  assert.ok(Array.isArray(sol.machines));
  assert.ok(Array.isArray(sol.shifts));
  assert.equal(sol.certificate.ok, true);
});

test('solve --out writes the solution file', () => {
  const inst = join(tmp, 'inst2.json');
  const out = join(tmp, 'sol2.json');
  writeFileSync(inst, JSON.stringify(feasibleInstance));
  const r = run(['solve', inst, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const sol = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(sol.status, 'optimal');
});

test('infeasible instance exits 0 with status infeasible and reasons', () => {
  const file = join(tmp, 'infeasible.json');
  writeFileSync(file, JSON.stringify({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 4, quotas: { A: 0 } }],
    orders: [{ id: 'J1', release: 0, duration: 2, deadline: 4, family: 'A', priority: 'normal', machines: ['M1'] }],
  }));
  const r = run(['solve', file]);
  assert.equal(r.code, 0, r.stderr);
  const sol = JSON.parse(r.stdout);
  assert.equal(sol.status, 'infeasible');
  assert.ok(sol.reasons.length > 0);
});

test('malformed JSON exits 1 and writes to stderr', () => {
  const file = join(tmp, 'bad.json');
  writeFileSync(file, '{ not json');
  const r = run(['solve', file]);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.stdout, '');
});

test('schema-invalid input exits 1 and writes to stderr', () => {
  const file = join(tmp, 'invalid.json');
  writeFileSync(file, JSON.stringify({
    machines: ['M1'],
    shifts: [{ id: 'S1', start: 0, end: 4, quotas: { A: 4 } }],
    orders: [{ id: 'J1', release: 0, duration: 0, deadline: 4, family: 'A', priority: 'normal', machines: ['M1'] }],
  }));
  const r = run(['solve', file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /duration/);
});

test('solve reads the instance from stdin', () => {
  const r = run(['solve', '-'], JSON.stringify(feasibleInstance));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'optimal');
});

test('verify accepts the solver output and rejects tampering', () => {
  const inst = join(tmp, 'inst3.json');
  const solFile = join(tmp, 'sol3.json');
  writeFileSync(inst, JSON.stringify(feasibleInstance));
  const solved = run(['solve', inst]);
  assert.equal(solved.code, 0, solved.stderr);
  writeFileSync(solFile, solved.stdout);

  const okRun = run(['verify', inst, solFile]);
  assert.equal(okRun.code, 0, okRun.stderr);
  assert.equal(JSON.parse(okRun.stdout).ok, true);

  const tampered = JSON.parse(solved.stdout);
  delete tampered.certificate;
  tampered.objective.totalTardiness += 1;
  writeFileSync(solFile, JSON.stringify(tampered));
  const badRun = run(['verify', inst, solFile]);
  assert.equal(badRun.code, 1);
  const res = JSON.parse(badRun.stdout);
  assert.equal(res.ok, false);
  assert.ok(res.checks.some((c) => c.id === 'objective' && !c.ok));
});

// End-to-end through a real child process. Some sandboxes forbid spawning;
// probe once and skip in that case.
const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
const spawnOk = !probe.error;

test('bin/mold-sched.js works as an executable process', { skip: !spawnOk }, () => {
  const file = join(tmp, 'inst-e2e.json');
  writeFileSync(file, JSON.stringify(feasibleInstance));
  const r = spawnSync(process.execPath, [BIN, 'solve', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'optimal');

  const bad = join(tmp, 'bad-e2e.json');
  writeFileSync(bad, '{ nope');
  const r2 = spawnSync(process.execPath, [BIN, 'solve', bad], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.length > 0);
});
