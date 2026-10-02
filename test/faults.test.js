import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, emit } from '../test-support/helpers.js';
import { Store } from '../src/store.js';
import { makeEvent } from '../src/events.js';

function setupLog(dir, n = 2) {
  assert.equal(emit(dir, 'site-a', 'u1', 'create', ['--wo', 'WO1']).status, 0);
  assert.equal(emit(dir, 'site-a', 'u1', 'assign', ['--wo', 'WO1', '--team', 'team-x']).status, 0);
  return n;
}

test('fault point 1: crash before event append leaves no partial state', () => {
  const dir = path.join(tmpdir(), 'd');
  // A rejected emit validates first and never touches the log.
  const r = emit(dir, 'site-a', 'u1', 'start', ['--wo', 'WO1']);
  assert.equal(r.status, 3);
  assert.ok(r.err.error);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
  const resume = runCli(['resume', '--dir', dir]);
  assert.equal(resume.status, 0);
  assert.equal(resume.json.logEvents, 0);
  assert.equal(resume.json.appliedEvents, 0);
  assert.deepEqual(resume.json.discardedTmp, []);
});

test('fault point 2: crash after append, before index -> resume rebuilds, no re-apply', () => {
  const dir = path.join(tmpdir(), 'd');
  setupLog(dir);
  // Simulate a crash: a third event exists in the log but index/state/audit
  // still describe only the first two.
  const e3 = makeEvent({
    site: 'site-a', seq: 3, vc: { 'site-a': 3 }, kind: 'wo', op: 'start',
    wo: 'WO1', alarm: null, actor: 'u1', team: null, interlock: false, ts: 't3',
  });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(e3) + '\n');

  const r1 = runCli(['resume', '--dir', dir]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.json.rebuiltIndex, true);
  assert.equal(r1.json.snapshot, 'rebuilt');
  assert.equal(r1.json.appliedEvents, 3);
  // The uncovered event is back-filled into the audit trail exactly once.
  assert.equal(r1.json.recoveryAudit, 1);

  let store = Store.open(dir);
  assert.equal(store.state.workorders.WO1.status, 'in_progress');
  assert.equal(Object.keys(store.state.applied).length, 3);

  // Recovery is idempotent: a second run must not re-apply anything.
  const r2 = runCli(['resume', '--dir', dir]);
  assert.equal(r2.status, 0);
  assert.equal(r2.json.rebuiltIndex, false);
  assert.equal(r2.json.snapshot, 'valid');
  assert.equal(r2.json.recoveryAudit, 0);
  assert.equal(r2.json.appliedEvents, 3);
  store = Store.open(dir);
  assert.equal(Object.keys(store.state.applied).length, 3);
});

test('fault point 3: crash before snapshot rename -> tmp discarded, old snapshot authoritative', () => {
  const dir = path.join(tmpdir(), 'd');
  setupLog(dir);
  // Orphaned tmp from a torn snapshot write.
  fs.writeFileSync(path.join(dir, 'state.json.tmp'), '{"garbage": true');
  const before = Store.open(dir).state;
  const r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.discardedTmp, ['state.json.tmp']);
  assert.equal(r.json.snapshot, 'valid');
  assert.deepEqual(Store.open(dir).state, before);
});

test('fault point 3b: snapshot lost with tmp leftover -> rebuild from log, tmp never trusted', () => {
  const dir = path.join(tmpdir(), 'd');
  setupLog(dir);
  fs.renameSync(path.join(dir, 'state.json'), path.join(dir, 'state.json.tmp'));
  const r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.discardedTmp, ['state.json.tmp']);
  assert.equal(r.json.snapshot, 'rebuilt');
  assert.equal(Store.open(dir).state.workorders.WO1.status, 'assigned');
});

test('fault point 4: crash after audit manifest commit -> consistent, nothing to repair', () => {
  const dir = path.join(tmpdir(), 'd');
  setupLog(dir);
  const r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.truncatedAudit, 0);
  const verify = runCli(['audit', '--dir', dir, '--verify']);
  assert.equal(verify.status, 0);
  assert.equal(verify.json.verified, true);
});

test('fault point 4b: torn audit tail past the manifest is truncated', () => {
  const dir = path.join(tmpdir(), 'd');
  setupLog(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // Crash after appending an audit line but before committing the manifest.
  fs.appendFileSync(
    path.join(dir, 'audit.jsonl'),
    JSON.stringify({ seq: 99, op: 'start', event: 'deadbeef', prev: 'bad', hash: 'bad' }) + '\n',
  );
  const r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 0);
  assert.equal(r.json.truncatedAudit, 1);
  const verify = runCli(['audit', '--dir', dir, '--verify']);
  assert.equal(verify.status, 0);
  assert.equal(verify.json.count, manifest.count);
  assert.equal(verify.json.entries, manifest.count);
});

test('duplicate delivery via apply is a no-op', () => {
  const dirA = path.join(tmpdir(), 'a');
  const dirB = path.join(tmpdir(), 'b');
  setupLog(dirA);
  const file = path.join(dirA, 'events.jsonl');
  const first = runCli(['apply', '--dir', dirB, '--file', file]);
  assert.equal(first.status, 0);
  assert.equal(first.json.appended, 2);
  assert.equal(first.json.duplicates, 0);
  const second = runCli(['apply', '--dir', dirB, '--file', file]);
  assert.equal(second.status, 0);
  assert.equal(second.json.appended, 0);
  assert.equal(second.json.duplicates, 2);
  assert.equal(second.json.applied, 2);
  // Applying a store's own log back to itself is also a no-op.
  const self = runCli(['apply', '--dir', dirA, '--file', file]);
  assert.equal(self.status, 0);
  assert.equal(self.json.appended, 0);
  assert.equal(self.json.duplicates, 2);
});
