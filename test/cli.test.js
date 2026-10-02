import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// Runs the CLI as a real subprocess. stdio is routed through files because
// nested-process pipes are not reliable in every sandbox.
function runCli(args, { stdinText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'molding-cli-'));
  const inPath = join(dir, 'in.json');
  const outPath = join(dir, 'out.json');
  const errPath = join(dir, 'err.txt');
  const rcPath = join(dir, 'rc.txt');
  if (stdinText !== undefined) writeFileSync(inPath, stdinText);
  const quoted = [CLI, ...args].map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(' ');
  const redirect = stdinText !== undefined ? ` < '${inPath}'` : ' < /dev/null';
  const cmd = `${process.execPath} ${quoted}${redirect} > '${outPath}' 2> '${errPath}'; echo $? > '${rcPath}'`;
  const r = spawnSync('bash', ['-c', cmd], { stdio: 'inherit', timeout: 60000 });
  assert.equal(r.status, 0, 'wrapper shell failed');
  return {
    status: Number(readFileSync(rcPath, 'utf8').trim()),
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
    dir,
  };
}

const VALID = JSON.stringify({
  machines: [{ id: 'M1' }],
  shifts: [{ id: 'S1', start: 0, end: 6, quotas: { A: 6 } }],
  orders: [{ id: 'J1', release: 0, duration: 2, deadline: 4, family: 'A', priority: 'low', machines: ['M1'] }],
});

test('cli: solves a valid instance from stdin, exit 0, JSON on stdout', () => {
  const r = runCli(['solve', '-'], { stdinText: VALID });
  assert.equal(r.status, 0, r.stderr);
  const sol = JSON.parse(r.stdout);
  assert.equal(sol.status, 'optimal');
  assert.equal(sol.objective.totalTardiness, 0);
  assert.equal(sol.certificate.ok, true);
});

test('cli: solves a valid instance from a file argument', () => {
  const first = runCli(['solve', '-'], { stdinText: VALID });
  const instancePath = join(first.dir, 'instance.json');
  writeFileSync(instancePath, VALID);
  const r = runCli(['solve', instancePath]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'optimal');
});

test('cli: infeasible instance exits 0 with status infeasible and reasons', () => {
  const infeasible = JSON.stringify({
    machines: [{ id: 'M1' }],
    shifts: [{ id: 'S1', start: 0, end: 4, quotas: { A: 0 } }],
    orders: [{ id: 'J1', release: 0, duration: 2, deadline: 3, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  const r = runCli(['solve', '-'], { stdinText: infeasible });
  assert.equal(r.status, 0, r.stderr);
  const sol = JSON.parse(r.stdout);
  assert.equal(sol.status, 'infeasible');
  assert.ok(Array.isArray(sol.reasons) && sol.reasons.length > 0);
});

test('cli: malformed JSON exits 1 and writes to stderr only', () => {
  const r = runCli(['solve', '-'], { stdinText: '{not json' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0);
  assert.equal(r.stdout.trim(), '');
});

test('cli: invalid instance (negative duration) exits 1 with stderr message', () => {
  const bad = JSON.stringify({
    machines: [{ id: 'M1' }],
    shifts: [],
    orders: [{ id: 'J1', release: 0, duration: -1, deadline: 4, family: 'A', priority: 'low', machines: ['M1'] }],
  });
  const r = runCli(['solve', '-'], { stdinText: bad });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duration/);
});

test('cli: invalid instance (unknown machine reference) exits 1', () => {
  const bad = JSON.stringify({
    machines: [{ id: 'M1' }],
    shifts: [],
    orders: [{ id: 'J1', release: 0, duration: 1, deadline: 4, family: 'A', priority: 'low', machines: ['M9'] }],
  });
  const r = runCli(['solve', '-'], { stdinText: bad });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown machine/);
});

test('cli: invalid instance (bad priority) exits 1', () => {
  const bad = JSON.stringify({
    machines: [{ id: 'M1' }],
    shifts: [],
    orders: [{ id: 'J1', release: 0, duration: 1, deadline: 4, family: 'A', priority: 'urgent', machines: ['M1'] }],
  });
  const r = runCli(['solve', '-'], { stdinText: bad });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /priority/);
});

test('cli: verify mode accepts a genuine certificate and rejects a forged one', () => {
  const solved = runCli(['solve', '-'], { stdinText: VALID });
  assert.equal(solved.status, 0, solved.stderr);
  const instancePath = join(solved.dir, 'instance.json');
  const solutionPath = join(solved.dir, 'solution.json');
  writeFileSync(instancePath, VALID);
  writeFileSync(solutionPath, solved.stdout);

  const okRun = runCli(['verify', instancePath, solutionPath]);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(JSON.parse(okRun.stdout).ok, true);

  const forged = JSON.parse(solved.stdout);
  forged.objective.totalTardiness += 1;
  writeFileSync(solutionPath, JSON.stringify(forged));
  const badRun = runCli(['verify', instancePath, solutionPath]);
  assert.equal(badRun.status, 1);
  const report = JSON.parse(badRun.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === 'total-tardiness-accurate' && !c.ok));
});
