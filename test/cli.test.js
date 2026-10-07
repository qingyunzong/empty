'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

// NOTE: in some sandboxed environments a child node process's stdout pipe
// cannot be captured, so stdout/stdin are routed through temp files.
function run(args, { env = {}, input } = {}) {
  const dir = tmpdir();
  const outFile = path.join(dir, 'stdout.txt');
  const outFd = fs.openSync(outFile, 'w');
  let inFd = 'ignore';
  if (input !== undefined) {
    const inFile = path.join(dir, 'stdin.txt');
    fs.writeFileSync(inFile, input);
    inFd = fs.openSync(inFile, 'r');
  }
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: [inFd, outFd, 'pipe'],
    encoding: 'utf8',
  });
  fs.closeSync(outFd);
  if (inFd !== 'ignore') fs.closeSync(inFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // keep null
  }
  return { status: res.status, json, stdout, stderr: res.stderr };
}

const JOBS_FILE = (dir, payload) => {
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
};

const JOBS_A = {
  jobs: [
    { id: 'J1', release: 0, due: 6, duration: 3 },
    { id: 'J2', release: 1, due: 5, duration: 2, devices: ['M1'] },
    { id: 'J3', release: 0, due: 10, duration: 4 },
    { id: 'J4', release: 2, due: 8, duration: 2 },
  ],
};
const JOBS_B = { jobs: [{ id: 'K1', release: 0, due: 4, duration: 2 }, { id: 'K2', release: 0, due: 9, duration: 3 }] };

test('CLI end-to-end: set-jobs, plan, verify, lookup', () => {
  const db = path.join(tmpdir(), 'db');
  let r = run(['set-jobs', '--db', db, '--file', JOBS_FILE(tmpdir(), JOBS_A)]);
  assert.deepEqual(r.json, { ok: true, jobsVersion: 1 });

  r = run(['plan', '--db', db]);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, 1);
  const cert = r.json.plan.certificate;
  assert.equal(typeof cert.inputHash, 'string');
  assert.equal(cert.objective, r.json.plan.objective);
  assert.ok(cert.tieCount >= 1 && cert.tieRank >= 1);

  r = run(['verify', '--db', db]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.diffs, []);

  r = run(['lookup', '--db', db, '--job', 'J2', '--device', 'M1']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.entry.jobId, 'J2');
  r = run(['lookup', '--db', db, '--job', 'J2', '--device', 'M2']);
  assert.equal(r.json.entry, null);
});

test('CLI crash injection respects the commit boundary', () => {
  const db = path.join(tmpdir(), 'db');
  run(['set-jobs', '--db', db, '--file', JOBS_FILE(tmpdir(), JOBS_A)]);
  run(['plan', '--db', db]);
  run(['set-jobs', '--db', db, '--file', JOBS_FILE(tmpdir(), JOBS_B)]);

  // Crash after the staged plan is durable but before the commit marker.
  let r = run(['plan', '--db', db], { env: { SCHED_CRASH: 'after_stage' } });
  assert.equal(r.status, 99);
  r = run(['current', '--db', db]);
  assert.equal(r.json.version, 1, 'staged plan must be discarded');
  assert.equal(r.json.plan.jobsVersion, 1);

  // Crash after the commit marker: the new version must become visible.
  r = run(['plan', '--db', db], { env: { SCHED_CRASH: 'after_commit' } });
  assert.equal(r.status, 99);
  r = run(['current', '--db', db]);
  assert.equal(r.json.version, 2, 'committed plan must be visible after recovery');
  assert.equal(r.json.plan.jobsVersion, 2);

  r = run(['recover', '--db', db]);
  assert.deepEqual(r.json, { ok: true, jobsVersion: 2, currentVersion: 2 });
});

test('CLI reports E_INFEASIBLE as JSON and keeps the old plan', () => {
  const db = path.join(tmpdir(), 'db');
  run(['set-jobs', '--db', db, '--file', JOBS_FILE(tmpdir(), JOBS_A)]);
  run(['plan', '--db', db]);
  const infeasible = {
    jobs: [
      { id: 'A', release: 0, due: 10, duration: 3 },
      { id: 'B', release: 0, due: 10, duration: 3 },
    ],
    devices: [{ id: 'M1', capacity: 4 }, { id: 'M2', capacity: 1 }],
  };
  run(['set-jobs', '--db', db, '--file', JOBS_FILE(tmpdir(), infeasible)]);
  const r = run(['plan', '--db', db]);
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'E_INFEASIBLE');
  assert.equal(r.json.error.details.jobId, 'A');
  const cur = run(['current', '--db', db]);
  assert.equal(cur.json.version, 1, 'old plan must survive the failed replan');
});

test('CLI reads jobs from stdin when --file is omitted', () => {
  const db = path.join(tmpdir(), 'db');
  const r = run(['set-jobs', '--db', db], { input: JSON.stringify(JOBS_B) });
  assert.equal(r.json.ok, true);
  const jobs = run(['jobs', '--db', db]);
  assert.equal(jobs.json.jobs.length, 2);
});
