import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

// NOTE: this sandbox cannot capture grandchild stdout via pipes, so the
// child's stdout/stderr are redirected to temp files and read back.
function run(args, { input } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-io-'));
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  let parsed = null;
  if (stdout.trim().length > 0) {
    parsed = JSON.parse(stdout.trim().split('\n').pop());
  }
  return { status: res.status, json: parsed, stderr };
}

const JOBS_V1 = {
  devices: ['M1', 'M2'],
  jobs: [
    { id: 'A', release: 0, due: 10, duration: 2 },
    { id: 'B', release: 1, due: 6, duration: 3 },
  ],
};
const JOBS_V2 = {
  devices: ['M1', 'M2'],
  jobs: [
    ...JOBS_V1.jobs,
    { id: 'C', release: 0, due: 8, duration: 1 },
  ],
};

test('CLI happy path: set-jobs -> plan -> show -> query', () => {
  const dir = tmpdir();
  let r = run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V1)]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json, { ok: true, version: 1, jobsVersion: 1 });

  r = run(['plan', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.planVersion, 1);
  assert.equal(r.json.plan.entries.length, 2);
  assert.equal(typeof r.json.plan.certificate.inputHash, 'string');
  assert.equal(r.json.plan.certificate.objective, r.json.plan.objective);
  assert.equal(typeof r.json.plan.certificate.tieRank, 'number');

  r = run(['show', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.planVersion, 1);
  assert.equal(r.json.plan.baseVersion, 1);

  const entry = r.json.plan.entries[0];
  r = run(['query', '--dir', dir, '--job-id', entry.jobId, '--device-id', entry.deviceId]);
  assert.deepEqual(r.json.found, true);
  assert.equal(r.json.assignment.start, entry.start);
  r = run(['query', '--dir', dir, '--job-id', entry.jobId, '--device-id', 'M9']);
  assert.deepEqual(r.json.found, false);
});

test('CLI snapshot conflict: plan --expect-version with stale version', () => {
  const dir = tmpdir();
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V1)]);
  let r = run(['plan', '--dir', dir, '--expect-version', '1']);
  assert.equal(r.status, 0, 'plan on current version succeeds');

  r = run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V2)]);
  assert.equal(r.json.jobsVersion, 2);

  // replay / replan against the old version must conflict
  r = run(['plan', '--dir', dir, '--expect-version', '1']);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'E_SNAPSHOT');
  assert.equal(r.json.error.expected, 1);
  assert.equal(r.json.error.actual, 2);

  // old plan still visible, not overwritten by the failed attempt
  r = run(['show', '--dir', dir]);
  assert.equal(r.json.planVersion, 1);
  assert.equal(r.json.plan.entries.length, 2);

  r = run(['plan', '--dir', dir, '--expect-version', '2']);
  assert.equal(r.status, 0);
  assert.equal(r.json.plan.entries.length, 3);
});

test('CLI crash after_stage: staged plan discarded, old plan retained', () => {
  const dir = tmpdir();
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V1)]);
  run(['plan', '--dir', dir]);
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V2)]);

  let r = run(['plan', '--dir', dir, '--crash', 'after_stage']);
  assert.equal(r.status, 3, 'crash injection exit code');
  assert.equal(r.json, null, 'no output on crash');

  r = run(['show', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.jobsVersion, 2, 'committed jobs update survives');
  assert.equal(r.json.planVersion, 1, 'staged plan discarded: old plan version retained');
  assert.equal(r.json.plan.entries.length, 2, 'old plan content intact');
  assert.equal(r.json.plan.baseVersion, 1);

  // recovery is clean: a fresh plan commits normally afterwards
  r = run(['plan', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.planVersion, 2);
  assert.equal(r.json.plan.entries.length, 3);
});

test('CLI crash after_commit: new plan fully visible after restart', () => {
  const dir = tmpdir();
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V1)]);
  run(['plan', '--dir', dir]);
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V2)]);

  let r = run(['plan', '--dir', dir, '--crash', 'after_commit']);
  assert.equal(r.status, 3);

  r = run(['show', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.planVersion, 2, 'commit marker durable: new plan visible');
  assert.equal(r.json.plan.entries.length, 3);
  assert.equal(r.json.plan.baseVersion, 2);

  const entry = r.json.plan.entries.find((e) => e.jobId === 'C');
  r = run(['query', '--dir', dir, '--job-id', 'C', '--device-id', entry.deviceId]);
  assert.equal(r.json.found, true, 'secondary index rebuilt for the new plan');
});

test('CLI infeasible input: E_INFEASIBLE with jobId, old plan preserved', () => {
  const dir = tmpdir();
  run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(JOBS_V1)]);
  run(['plan', '--dir', dir]);

  const bad = { devices: ['M1', 'M2'], jobs: [{ id: 'X', release: 0, due: 1, duration: 1, devices: [] }] };
  let r = run(['set-jobs', '--dir', dir, '--jobs', JSON.stringify(bad)]);
  assert.equal(r.status, 0, 'infeasible job set can be stored');
  r = run(['plan', '--dir', dir]);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'E_INFEASIBLE');
  assert.equal(r.json.error.jobId, 'X');

  r = run(['show', '--dir', dir]);
  assert.equal(r.json.planVersion, 1, 'error state did not overwrite old plan');
  assert.equal(r.json.plan.entries.length, 2);
});

test('CLI usage errors are JSON with exit code 2', () => {
  const r = run(['frobnicate']);
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'E_USAGE');
});
