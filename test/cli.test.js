'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run: cli } = require('../bin/cli.js');

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  fs.writeFileSync(
    path.join(dir, 'reviewers.json'),
    JSON.stringify({
      reviewers: [
        { id: 'R1', skills: ['echo'], unavailable: [{ start: 2, end: 4 }] },
        { id: 'R2', skills: ['ct'], unavailable: [] },
      ],
    })
  );
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ deptShare: 0.5, highRisk: 8, compensationCredit: 5 })
  );
  return dir;
}

function run(dir, ...args) {
  const res = cli(['--state', dir, ...args]);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function runErr(dir, ...args) {
  const res = cli(['--state', dir, ...args]);
  assert.notEqual(res.code, 0, 'expected a failing exit code');
  return { status: res.code, stderr: JSON.parse(res.stderr) };
}

test('exit code 8 for skill mismatch, past deadline and duplicate appeal', () => {
  const dir = makeDir();
  let r = runErr(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '5', '--deadline', '20', '--skill', 'mri', '--duration', '2', '--time', '0');
  assert.equal(r.status, 8);
  assert.equal(r.stderr.code, 'SKILL_MISMATCH');

  r = runErr(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '5', '--deadline', '3', '--skill', 'echo', '--duration', '2', '--time', '5');
  assert.equal(r.status, 8);
  assert.equal(r.stderr.code, 'DEADLINE_PAST');

  run(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '5', '--deadline', '20', '--skill', 'echo', '--duration', '2', '--time', '0');
  run(dir, 'assign', '--time', '0');
  run(dir, 'close', 'case', '--case', 'C1', '--result', 'approved', '--level', '1', '--time', '5');
  run(dir, 'appeal', '--case', 'C1', '--level', '1', '--time', '6');
  r = runErr(dir, 'appeal', '--case', 'C1', '--level', '2', '--time', '7');
  assert.equal(r.status, 8);
  assert.equal(r.stderr.code, 'DUPLICATE_APPEAL');
});

test('assign prints an auditable certificate with assignments and rejection codes', () => {
  const dir = makeDir();
  run(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '9', '--deadline', '20', '--skill', 'echo', '--duration', '2', '--time', '0');
  run(dir, 'open', '--case', 'C2', '--dept', 'neuro', '--risk', '4', '--deadline', '20', '--skill', 'ct', '--duration', '2', '--time', '0');
  const cert = run(dir, 'assign', '--time', '0');
  assert.equal(cert.kind, 'assignment-certificate');
  assert.equal(cert.method, 'exact');
  assert.equal(cert.assignments.length, 2);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  const c1 = cert.assignments.find((a) => a.caseId === 'C1');
  assert.equal(c1.reviewerId, 'R1');
  assert.ok(c1.start >= 4 || c1.end <= 2, 'R1 unavailable [2,4) must be avoided');
});

test('snapshot + crash recovery: certificate is recomputable after restart', () => {
  const dir = makeDir();
  run(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '9', '--deadline', '30', '--skill', 'echo', '--duration', '2', '--time', '0');
  run(dir, 'open', '--case', 'C2', '--dept', 'neuro', '--risk', '3', '--deadline', '30', '--skill', 'ct', '--duration', '2', '--time', '0');
  run(dir, 'assign', '--time', '0');
  const snap = run(dir, 'snapshot', '--time', '1');
  assert.ok(fs.existsSync(snap.snapshot));

  // More work after the snapshot, then a "crash": a torn final log record.
  run(dir, 'correct', '--case', 'C2', '--risk', '7', '--time', '2');
  run(dir, 'assign', '--time', '3');
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"type":"OPEN","time":4,"cas');

  const verify = run(dir, 'verify');
  assert.equal(verify.match, true);
  assert.equal(verify.recoveredHash, verify.recomputedHash);
});

test('concurrent events are ordered by (logical time, source, case id)', () => {
  const dir = makeDir();
  // Append two same-time events out of order directly to the log.
  run(dir, 'open', '--case', 'C1', '--dept', 'cardio', '--risk', '5', '--deadline', '30', '--skill', 'echo', '--duration', '2', '--time', '0');
  const logPath = path.join(dir, 'events.jsonl');
  const e1 = { type: 'CORRECT', time: 5, source: 'zzz', caseId: 'C1', risk: 6 };
  const e2 = { type: 'CORRECT', time: 5, source: 'aaa', caseId: 'C1', risk: 9 };
  fs.appendFileSync(logPath, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
  // Sorted by (time, source, caseId): e2 (source aaa) applies first, e1 last,
  // so the final risk must be 6 regardless of append order.
  const verify = run(dir, 'verify');
  assert.equal(verify.match, true);
  const { recover } = require('../src/store');
  assert.equal(recover(dir).state.cases.C1.risk, 6);
});
