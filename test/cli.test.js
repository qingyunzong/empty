import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, emit } from '../test-support/helpers.js';

test('exit 2 with JSON stderr on usage errors', () => {
  for (const args of [
    [],
    ['bogus'],
    ['emit', '--dir', '/tmp/x', '--site', 's', '--actor', 'u', 'frob'],
    ['emit', '--dir', '/tmp/x', '--site', 's', '--actor', 'u', 'create'], // missing --wo
    ['emit', '--dir', '/tmp/x', '--site', 's', '--actor', 'u', 'assign', '--wo', 'W'], // missing --team
    ['apply', '--dir', '/tmp/x'], // missing --file
    ['sync', '--a', '/tmp/x'], // missing --b
    ['resume'], // missing --dir
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 2, `args: ${args.join(' ')}`);
    assert.equal(r.err.error.code, 'USAGE');
    assert.equal(typeof r.err.error.message, 'string');
  }
});

test('exit 3 with JSON stderr on illegal transitions', () => {
  const dir = path.join(tmpdir(), 'd');
  // start on a non-existent WO
  let r = emit(dir, 's', 'u', 'start', ['--wo', 'W']);
  assert.equal(r.status, 3);
  assert.equal(r.err.error.code, 'REJECTED');
  assert.equal(r.err.error.reason, 'no-such-wo');
  // happy path to completed
  assert.equal(emit(dir, 's', 'u', 'create', ['--wo', 'W']).status, 0);
  r = emit(dir, 's', 'u', 'complete', ['--wo', 'W']);
  assert.equal(r.status, 3);
  assert.equal(r.err.error.detail, 'new->complete');
  assert.equal(emit(dir, 's', 'u', 'assign', ['--wo', 'W', '--team', 't']).status, 0);
  assert.equal(emit(dir, 's', 'u', 'start', ['--wo', 'W']).status, 0);
  assert.equal(emit(dir, 's', 'u', 'complete', ['--wo', 'W']).status, 0);
  // complete -> start forbidden
  r = emit(dir, 's', 'u', 'start', ['--wo', 'W']);
  assert.equal(r.status, 3);
  assert.equal(r.err.error.detail, 'completed->start');
  // cancel -> assign forbidden
  assert.equal(emit(dir, 's', 'u', 'create', ['--wo', 'W2']).status, 0);
  assert.equal(emit(dir, 's', 'u', 'cancel', ['--wo', 'W2']).status, 0);
  r = emit(dir, 's', 'u', 'assign', ['--wo', 'W2', '--team', 't']);
  assert.equal(r.status, 3);
  assert.equal(r.err.error.detail, 'cancelled->assign');
  // clear of unknown alarm
  r = emit(dir, 's', 'u', 'clear', ['--wo', 'W', '--alarm', 'A1']);
  assert.equal(r.status, 3);
  assert.equal(r.err.error.reason, 'raise-unknown');
});

test('exit 9 with JSON stderr on integrity failures', () => {
  const dir = path.join(tmpdir(), 'd');
  assert.equal(emit(dir, 's', 'u', 'create', ['--wo', 'W']).status, 0);
  // Corrupt the event log.
  fs.appendFileSync(path.join(dir, 'events.jsonl'), 'not json\n');
  let r = runCli(['resume', '--dir', dir]);
  assert.equal(r.status, 9);
  assert.equal(r.err.error.code, 'INTEGRITY');
});

test('exit 9 on tampered committed audit entries (audit --verify)', () => {
  const dir = path.join(tmpdir(), 'd');
  assert.equal(emit(dir, 's', 'u', 'create', ['--wo', 'W']).status, 0);
  assert.equal(emit(dir, 's', 'u', 'cancel', ['--wo', 'W']).status, 0);
  // Untampered: verifies fine.
  let r = runCli(['audit', '--dir', dir, '--verify']);
  assert.equal(r.status, 0);
  assert.equal(r.json.verified, true);
  // Tamper with a committed entry.
  const p = path.join(dir, 'audit.jsonl');
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.reason = 'forged';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  r = runCli(['audit', '--dir', dir, '--verify']);
  assert.equal(r.status, 9);
  assert.equal(r.err.error.code, 'INTEGRITY');
});

test('emit/apply/sync/resume/audit happy path exit 0 with JSON stdout', () => {
  const a = path.join(tmpdir(), 'a');
  const b = path.join(tmpdir(), 'b');
  assert.equal(emit(a, 'site-a', 'u', 'create', ['--wo', 'W']).status, 0);
  assert.equal(emit(b, 'site-b', 'u', 'create', ['--wo', 'W2']).status, 0);
  const s = runCli(['sync', '--a', a, '--b', b]);
  assert.equal(s.status, 0);
  assert.equal(s.json.converged, true);
  assert.equal(s.json.aToB, 1);
  assert.equal(s.json.bToA, 1);
  const r = runCli(['resume', '--dir', a]);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  const au = runCli(['audit', '--dir', a]);
  assert.equal(au.status, 0);
  assert.ok(au.json.entries >= 2);
});
