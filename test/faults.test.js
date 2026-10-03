import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, initPair, expectOk } from './helpers.js';

const MOVE = '{"type":"move","op":"J2.o1","machine":"M2","index":0}';

function setup() {
  const root = tmpdir();
  const { a } = initPair(root);
  const certBefore = expectOk(cli(['export-cert', '--dir', a])).stdout;
  return { root, a, certBefore };
}

function crashApply(a, point) {
  const r = cli(['apply', '--dir', a, '--change', MOVE], { env: { PLAN_SYNC_FAULT: point } });
  assert.equal(r.code, 86, `expected injected crash exit 86, got ${r.code}`);
  const err = r.errJson();
  assert.equal(err.error.code, 'FAULT_INJECTED');
  assert.equal(err.error.point, point);
  return r;
}

test('fault 1: crash before log append recovers to previous consistent point', () => {
  const { a, certBefore } = setup();
  crashApply(a, 'before-append');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 0, resume.stderr);
  const report = resume.json();
  assert.equal(report.status, 'recovered');
  assert.equal(report.committed.status, 'committed');
  assert.equal(report.replayed, 0);
  assert.equal(report.truncatedTail, false);
  assert.equal(report.discardedTmpSnapshot, false);
  assert.deepEqual(report.clock, {});
  const certAfter = expectOk(cli(['export-cert', '--dir', a])).stdout;
  assert.equal(certAfter, certBefore, 'state must equal the last consistent point');
});

test('fault 2: crash after append without fsync drops the torn tail', () => {
  const { a, certBefore } = setup();
  crashApply(a, 'after-append-no-fsync');
  const logSize = fs.statSync(path.join(a, 'log.jsonl')).size;
  assert.ok(logSize > 0, 'un-fsynced bytes are present before recovery');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 0, resume.stderr);
  const report = resume.json();
  assert.equal(report.truncatedTail, true, 'torn tail must be detected and truncated');
  assert.equal(report.replayed, 0);
  assert.equal(fs.statSync(path.join(a, 'log.jsonl')).size, 0, 'log truncated back to committed length');
  const certAfter = expectOk(cli(['export-cert', '--dir', a])).stdout;
  assert.equal(certAfter, certBefore);
});

test('fault 3: crash before snapshot rename discards the half snapshot and replays the log', () => {
  const { a, certBefore } = setup();
  crashApply(a, 'before-rename');
  assert.ok(fs.existsSync(path.join(a, 'snapshot.tmp.json')), 'half snapshot exists before recovery');
  const tmp = fs.readFileSync(path.join(a, 'snapshot.tmp.json'));
  assert.throws(() => JSON.parse(tmp.toString('utf8')), 'tmp snapshot is a torn half-write');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 0, resume.stderr);
  const report = resume.json();
  assert.equal(report.discardedTmpSnapshot, true, 'half snapshot must be discarded');
  assert.equal(report.replayed, 1, 'fsynced log entry must be replayed');
  assert.ok(!fs.existsSync(path.join(a, 'snapshot.tmp.json')));
  const cert = JSON.parse(expectOk(cli(['export-cert', '--dir', a])).stdout);
  assert.equal(cert.schedule.M2[0], 'J2.o1', 'replayed change is visible');
  assert.notEqual(JSON.stringify(cert), certBefore);
  assert.equal(cli(['verify', '--dir', a]).code, 0);
});

test('fault 4: crash after manifest commit reports the committed state', () => {
  const { a } = setup();
  crashApply(a, 'after-manifest');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 0, resume.stderr);
  const report = resume.json();
  assert.equal(report.committed.status, 'committed');
  assert.equal(report.committed.logLen, 1);
  assert.deepEqual(report.clock, { A: 1 });
  assert.equal(report.replayed, 0);
  assert.equal(report.discardedTmpSnapshot, false);
  const cert = JSON.parse(expectOk(cli(['export-cert', '--dir', a])).stdout);
  assert.equal(cert.schedule.M2[0], 'J2.o1', 'committed change survived the crash');
});

test('recovery failure: corrupted committed log exits 4 with JSON error', () => {
  const { a } = setup();
  expectOk(cli(['apply', '--dir', a, '--change', MOVE]));
  fs.writeFileSync(path.join(a, 'log.jsonl'), '{"type":"move"\n{"corrupted":true}\n');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 4);
  assert.equal(resume.errJson().error.code, 'RECOVERY_FAILED');
});

test('recovery failure: snapshot hash mismatch exits 4', () => {
  const { a } = setup();
  fs.writeFileSync(path.join(a, 'snapshot.json'), '{"format":1,"tampered":true}\n');
  const resume = cli(['resume', '--dir', a]);
  assert.equal(resume.code, 4);
  assert.equal(resume.errJson().error.code, 'RECOVERY_FAILED');
});

test('recovery failure: missing manifest exits 4', () => {
  const root = tmpdir();
  const resume = cli(['resume', '--dir', path.join(root, 'nowhere')]);
  assert.equal(resume.code, 4);
  assert.equal(resume.errJson().error.code, 'RECOVERY_FAILED');
});
