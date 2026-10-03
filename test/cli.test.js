// End-to-end CLI tests: JSONL in/out and exit codes
// (0 ok, 1 audit violation, 2 usage, 8 stale claim, 9 persistence failure,
// 70 simulated crash). The CLI entry is invoked in-process because the test
// sandbox forbids spawning child processes; main() is fully synchronous.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main } from '../src/cli.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(argv) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let status;
  try {
    status = main(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { status, stdout: out.join(''), stderr: err.join('') };
}

function jsonl(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeEvents(dir, events) {
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('replay: JSONL in, JSONL decisions + summary out, exit 0', (t) => {
  const dir = tmpDir(t);
  const input = writeEvents(dir, [
    { type: 'join', agv: 'A', ts: 0 },
    { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } },
  ]);
  const res = runCli(['replay', '--in', input]);
  assert.equal(res.status, 0, res.stderr);
  const lines = jsonl(res.stdout);
  assert.equal(lines[0].decision, 'joined');
  assert.equal(lines[1].decision, 'granted');
  const summary = lines.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.tasks.T1.holder, 'A');
});

test('replay: low-epoch claim exits 8 and reports stale', (t) => {
  const dir = tmpDir(t);
  const input = writeEvents(dir, [
    { type: 'join', agv: 'A', ts: 0 },
    { type: 'join', agv: 'B', ts: 0 },
    { type: 'claim', task: 'T1', agv: 'A', epoch: 2, ttl: 100, ts: 0, clock: { A: 1 } },
    { type: 'claim', task: 'T1', agv: 'B', epoch: 1, ttl: 100, ts: 1, clock: { A: 1, B: 1 } },
  ]);
  const res = runCli(['replay', '--in', input]);
  assert.equal(res.status, 8);
  const lines = jsonl(res.stdout);
  assert.equal(lines[3].decision, 'stale');
  assert.equal(lines.at(-1).staleClaims, 1);
});

test('replay --state + crash point, then recover and audit via CLI', (t) => {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  const input = writeEvents(dir, [
    { type: 'join', agv: 'A', ts: 0 },
    { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } },
  ]);
  for (const [point, expectAdopt] of [['after-tmp-write', false], ['before-rename', false], ['after-rename', true]]) {
    fs.rmSync(state, { recursive: true, force: true });
    const crashed = runCli(['replay', '--in', input, '--state', state, '--crash-point', point]);
    assert.equal(crashed.status, 70, `crash exit at ${point}`);
    assert.match(crashed.stderr, new RegExp(`"point":"${point}"`));

    const recovered = runCli(['recover', '--state', state]);
    assert.equal(recovered.status, 0, recovered.stderr);
    const report = jsonl(recovered.stdout);
    assert.equal(report.at(-1).type, 'recovery');
    assert.equal(report.at(-1).ok, true);
    assert.equal(report.some((r) => r.op === 'adopt-lease'), expectAdopt, `adopt only after rename (${point})`);
    if (!expectAdopt) assert.ok(report.some((r) => r.op === 'discard-tmp'));

    const audited = runCli(['audit', '--state', state]);
    assert.equal(audited.status, 0, audited.stderr);
    assert.equal(jsonl(audited.stdout).at(-1).ok, true);
  }
});

test('persistence validation failure exits 9 on recover and audit', (t) => {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  const input = writeEvents(dir, [
    { type: 'join', agv: 'A', ts: 0 },
    { type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } },
  ]);
  assert.equal(runCli(['replay', '--in', input, '--state', state]).status, 0);
  const leaseFile = path.join(state, 'leases', 'T1.json');
  const rec = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  rec.holder = 'EVIL'; // tamper, checksum now invalid
  fs.writeFileSync(leaseFile, JSON.stringify(rec) + '\n');

  const recovered = runCli(['recover', '--state', state]);
  assert.equal(recovered.status, 9);
  assert.match(recovered.stderr, /checksum/);
  const audited = runCli(['audit', '--state', state]);
  assert.equal(audited.status, 9);
});

test('audit detects a hand-crafted double ownership and exits 1', (t) => {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'leases'), { recursive: true });
  const grant = (seq, tseq, agv, epoch, ts) => JSON.stringify({
    seq,
    tseq,
    ev: { type: 'claim', task: 'T1', agv, epoch, ts },
    lease: { task: 'T1', holder: agv, epoch, expiry: 100, status: 'active', clock: {}, tseq, ts },
  });
  const journal = [
    JSON.stringify({ seq: 1, ev: { type: 'join', agv: 'A', ts: 0 } }),
    JSON.stringify({ seq: 2, ev: { type: 'join', agv: 'B', ts: 0 } }),
    grant(3, 1, 'A', 1, 0),
    grant(4, 2, 'B', 2, 10), // second active grant while A's lease is live
  ];
  fs.writeFileSync(path.join(state, 'events.jsonl'), journal.join('\n') + '\n');
  // Committed lease matches the last journal entry so recovery stays clean.
  const lease = { task: 'T1', holder: 'B', epoch: 2, expiry: 100, status: 'active', clock: {}, tseq: 2, ts: 10 };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(lease)).digest('hex');
  fs.writeFileSync(path.join(state, 'leases', 'T1.json'), JSON.stringify({ ...lease, checksum }) + '\n');
  const res = runCli(['audit', '--state', state]);
  assert.equal(res.status, 1);
  const lines = jsonl(res.stdout);
  assert.ok(lines.some((l) => l.violation && l.violation.type === 'double-ownership'));
  assert.equal(lines.at(-1).ok, false);
});

test('lease claim/show round-trip; stale claim exits 8', (t) => {
  const dir = tmpDir(t);
  const state = path.join(dir, 'state');
  let res = runCli(['lease', 'claim', '--state', state, '--task', 'T1', '--agv', 'A', '--epoch', '2', '--ttl', '100', '--now', '0']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).decision, 'granted');

  res = runCli(['lease', 'claim', '--state', state, '--task', 'T1', '--agv', 'B', '--epoch', '1', '--now', '10', '--clock', '{"A":1,"B":1}']);
  assert.equal(res.status, 8, 'low-epoch claim exits 8');
  assert.equal(JSON.parse(res.stdout).decision, 'stale');

  res = runCli(['lease', 'claim', '--state', state, '--task', 'T1', '--agv', 'B', '--epoch', '3', '--now', '10', '--clock', '{"A":2,"B":1}']);
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).decision, 'blocked-lease', 'live lease blocks takeover');

  res = runCli(['lease', 'show', '--state', state, '--task', 'T1']);
  assert.equal(res.status, 0);
  const lease = JSON.parse(res.stdout);
  assert.equal(lease.holder, 'A');
  assert.equal(lease.status, 'active');
  assert.equal(typeof lease.checksum, 'string');
});

test('usage error exits 2', () => {
  const res = runCli(['replay']);
  assert.equal(res.status, 2);
});
