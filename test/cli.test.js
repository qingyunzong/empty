import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

async function run(input, dir) {
  const out = [];
  const err = [];
  const status = await runCli({
    input,
    dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

test('CLI emits JSONL diffs with proof and persists across runs', async () => {
  const dir = tmpdir();
  const script = [
    { op: 'add_rule', rule: { id: 'm1', freq: 'monthly', interval: 1 } },
    { op: 'add_contract', contract: { id: 'L1', type: 'loan', start: '2024-01-31', end: '2024-03-31', ruleId: 'm1', amount: 100 } },
    { op: 'set_calendar', calendar: { version: 'v2', holidays: ['2024-02-29'] } },
  ].map((c) => JSON.stringify(c)).join('\n');

  const r1 = await run(script + '\n', dir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stderr, '');
  const lines = r1.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.ok));

  const addDiff = lines[1].diff;
  assert.equal(addDiff.added.length, 3);
  assert.deepEqual(addDiff.added.map((t) => t.due), ['2024-01-31', '2024-02-29', '2024-03-31']);
  assert.match(addDiff.proof.stateHash, /^[0-9a-f]{64}$/);

  const calDiff = lines[2].diff; // leap-day holiday moves task to 2024-03-01
  assert.deepEqual(calDiff.removed, ['L1#1']);
  assert.equal(calDiff.added[0].date, '2024-03-01');
  assert.deepEqual(calDiff.batches.invalidated, ['B@2024-02-29']);
  assert.deepEqual(calDiff.batches.added, ['B@2024-03-01']);

  // Second process: state survives restart; dump reflects it.
  const r2 = await run(JSON.stringify({ op: 'dump' }) + '\n', dir);
  assert.equal(r2.status, 0, r2.stderr);
  const dump = JSON.parse(r2.stdout.trim());
  assert.equal(dump.diff.state.tasks.length, 3);
  assert.equal(dump.diff.state.calendar.version, 'v2');
  assert.equal(dump.diff.proof.stateHash, lines[2].diff.proof.stateHash);
});

test('CLI reports BAD_RANGE on stderr and exits with code 10', async () => {
  const dir = tmpdir();
  const script = [
    { op: 'add_rule', rule: { id: 'm1', freq: 'monthly', interval: 1 } },
    { op: 'add_contract', contract: { id: 'B1', start: '2024-05-01', end: '2024-04-01', ruleId: 'm1', amount: 1 } },
  ].map((c) => JSON.stringify(c)).join('\n');
  const r = await run(script + '\n', dir);
  assert.equal(r.status, 10);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'BAD_RANGE');
  // The good op before the error was still acknowledged on stdout.
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('CLI rejects malformed JSONL with exit code 10', async () => {
  const dir = tmpdir();
  const r = await run('{"op":"add_rule"\n', dir);
  assert.equal(r.status, 10);
  assert.equal(JSON.parse(r.stderr.trim()).error.code, 'BAD_JSON');
});
