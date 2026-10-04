// CLI tests run in-process (the sandbox forbids spawning grandchildren):
// main() is invoked directly while stdout/stderr writes are captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { tmpdir } from './helpers.mjs';

function run(args, { env = {} } = {}) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const savedEnv = { ...process.env };
  Object.assign(process.env, env);
  process.stdout.write = (s) => (out.push(s), true);
  process.stderr.write = (s) => (err.push(s), true);
  let status;
  try {
    status = main(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.env = savedEnv;
  }
  return { status, stdout: out.join(''), stderr: err.join('') };
}

const stderrJsonLines = (r) => r.stderr.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function writeJsonl(dir, name, events) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

const scan = (id, ts, qty = 1) => ({ id, ts, device: 'PLC1', lot: 'L1', kind: 'quality.scan', payload: { result: 'pass', qty } });

test('ingest: exit 0 on success, stdout JSON report', () => {
  const dir = tmpdir();
  const file = writeJsonl(dir, 'ev.jsonl', [scan('a', 1), scan('b', 2)]);
  const r = run(['ingest', '--dir', path.join(dir, 's'), '--file', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).applied, 2);
});

test('ingest: VALIDATION problems -> exit 2 with JSON on stderr', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, '{"id":"x","ts":"oops"}\nnot-json\n' + JSON.stringify({ id: 'r', ts: 1, device: 'D', lot: 'L', kind: 'quality.release', payload: {} }) + '\n');
  const r = run(['ingest', '--dir', path.join(dir, 's'), '--file', bad]);
  assert.equal(r.status, 2);
  const lines = stderrJsonLines(r);
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => l.code === 'VALIDATION' && l.ok === false));
});

test('ingest: concurrent hold/release conflict -> exit 4, cert explains the lock', () => {
  const dir = tmpdir();
  const store = path.join(dir, 's');
  const file = writeJsonl(dir, 'ev.jsonl', [
    { id: 's0', ts: 1, device: 'D', lot: 'L1', kind: 'quality.scan', payload: { result: 'pass' } },
    { id: 'h1', ts: 2, device: 'D', lot: 'L1', kind: 'quality.hold', payload: { auto: true, deps: ['s0'] } },
    { id: 'r1', ts: 3, device: 'D', lot: 'L1', kind: 'quality.release', payload: { deps: ['s0'] } },
  ]);
  const r = run(['ingest', '--dir', store, '--file', file]);
  assert.equal(r.status, 4, r.stderr);
  const cert = run(['cert', '--dir', store, '--lot', 'L1']);
  assert.equal(cert.status, 0);
  const c = JSON.parse(cert.stdout);
  assert.equal(c.status, 'held');
  assert.match(c.explanation, /safety-first/);
});

test('resume after injected crash at a fault point -> exit 0, exactly-once', () => {
  const dir = tmpdir();
  const store = path.join(dir, 's');
  const file = writeJsonl(dir, 'ev.jsonl', [scan('a', 1, 3), scan('b', 2, 4)]);
  const crashed = run(['ingest', '--dir', store, '--file', file], { env: { EVENT_TRACE_FAILPOINT: 'after-index' } });
  assert.equal(crashed.status, 3);
  assert.equal(stderrJsonLines(crashed)[0].code, 'STORAGE');

  const resumed = run(['resume', '--dir', store]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const audit = run(['audit', '--dir', store]);
  assert.equal(audit.status, 0);
  const report = JSON.parse(audit.stdout);
  assert.equal(report.events, 2);
  assert.equal(report.appliedSeq, 2);
  assert.equal(report.ok, true);
});

test('audit detects store corruption -> exit 3', () => {
  const dir = tmpdir();
  const store = path.join(dir, 's');
  const file = writeJsonl(dir, 'ev.jsonl', [scan('a', 1)]);
  assert.equal(run(['ingest', '--dir', store, '--file', file]).status, 0);
  fs.writeFileSync(path.join(store, 'index.json'), '{"ids":{"phantom":99}}');
  const r = run(['audit', '--dir', store]);
  assert.equal(r.status, 3);
  assert.ok(stderrJsonLines(r).every((l) => l.code === 'STORAGE'));
});

test('unknown command -> exit 2 with JSON stderr', () => {
  const r = run(['frobnicate']);
  assert.equal(r.status, 2);
  assert.equal(stderrJsonLines(r)[0].code, 'VALIDATION');
});

test('sync: two offline stores converge bidirectionally, no loss no dup', () => {
  const dir = tmpdir();
  const edge = path.join(dir, 'edge');
  const base = path.join(dir, 'base');
  const f1 = writeJsonl(dir, 'a.jsonl', [scan('e1', 1, 2), { id: 'h1', ts: 2, device: 'D', lot: 'L1', kind: 'quality.hold', payload: {} }]);
  const f2 = writeJsonl(dir, 'b.jsonl', [
    scan('e1', 1, 2), // same event on both sides: must dedup
    scan('e2', 3, 5),
    { id: 'r1', ts: 4, device: 'D', lot: 'L1', kind: 'quality.release', payload: { deps: ['h1'] } },
  ]);
  assert.equal(run(['ingest', '--dir', edge, '--file', f1]).status, 0);
  assert.equal(run(['ingest', '--dir', base, '--file', f2]).status, 4); // h1 unknown here -> pending, not failed

  const sync = run(['sync', '--dir', edge, '--peer', base]);
  assert.equal(sync.status, 0, sync.stderr);
  const report = JSON.parse(sync.stdout);
  assert.equal(report.converged, true);
  assert.equal(report.events, 4); // e1 deduped

  for (const s of [edge, base]) {
    const a = JSON.parse(run(['audit', '--dir', s]).stdout);
    assert.equal(a.ok, true);
    assert.equal(a.events, 4);
  }
  const cert = JSON.parse(run(['cert', '--dir', edge, '--lot', 'L1']).stdout);
  assert.equal(cert.status, 'normal'); // hold then causal release
});

test('sync resolves pending lots when the missing ancestor arrives from the peer', () => {
  const dir = tmpdir();
  const edge = path.join(dir, 'edge');
  const base = path.join(dir, 'base');
  const fEdge = writeJsonl(dir, 'edge.jsonl', [
    { id: 'h1', ts: 5, device: 'D', lot: 'L9', kind: 'quality.hold', payload: { deps: ['root'] } },
  ]);
  const fBase = writeJsonl(dir, 'base.jsonl', [
    { id: 'root', ts: 1, device: 'D', lot: 'L9', kind: 'quality.scan', payload: { result: 'pass' } },
  ]);
  assert.equal(run(['ingest', '--dir', edge, '--file', fEdge]).status, 4); // pending
  assert.equal(run(['ingest', '--dir', base, '--file', fBase]).status, 0);
  const sync = run(['sync', '--dir', edge, '--peer', base]);
  assert.equal(sync.status, 0, sync.stderr);
  const cert = JSON.parse(run(['cert', '--dir', edge, '--lot', 'L9']).stdout);
  assert.equal(cert.status, 'held');
  assert.equal(cert.pending, null);
});
