'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execute } = require('../cli');

function writeTmp(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mes-')), 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runCli(args) {
  const { code, stdout, stderr } = execute(args);
  return { status: code, stdout, stderr };
}

const ev = (over) => JSON.stringify({
  lot: 'L1', mold: 'M1', station: 'S1', seq: 1, ts: 100,
  kind: 'produce', qty: 10, hash: 'h1', ...over,
});

test('CLI: valid run exits 0 and prints canonical chain, gaps, certificates', () => {
  const file = writeTmp([
    ev({ seq: 3, ts: 300, hash: 'h3' }),
    ev({ seq: 1, ts: 100, hash: 'h1' }),
    ev({ seq: 1, ts: 100, hash: 'h1' }), // duplicate
    ev({ seq: 2, ts: 200, hash: 'h2' }),
  ]);
  const res = runCli([file, '--now', '5000']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.chain.map((e) => e.seq), [1, 2, 3]);
  assert.equal(out.stats.duplicates, 1);
  assert.equal(out.gaps.length, 0);
  assert.equal(out.certificates.length, 1);
  assert.equal(out.certificates[0].status, 'active');
  assert.match(out.certificates[0].certHash, /^[0-9a-f]{64}$/);
});

test('CLI: gap appears in gap table once deadline passed', () => {
  const file = writeTmp([
    ev({ seq: 1, ts: 100, hash: 'h1' }),
    ev({ seq: 3, ts: 300, hash: 'h3' }),
  ]);
  const res = runCli([file, '--now', '5000', '--deadline', '1000']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.gaps.map((g) => g.seq), [2]);
  assert.deepEqual(out.chain.map((e) => e.seq), [1, 3]); // gap does not block later batches
});

test('CLI: invalid JSON input exits 2', () => {
  const file = writeTmp(['{broken']);
  const res = runCli([file, '--now', '5000']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid JSON/);
});

test('CLI: schema violation exits 2', () => {
  const file = writeTmp([ev({ seq: -3 })]);
  const res = runCli([file]);
  assert.equal(res.status, 2);
});

test('CLI: missing file and bad args exit 2', () => {
  assert.equal(runCli(['/nonexistent/events.jsonl']).status, 2);
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['--now', 'abc', 'x.jsonl']).status, 2);
});

test('CLI: conservation violation exits 4', () => {
  const file = writeTmp([
    ev({ seq: 1, qty: 100, hash: 'h1' }),
    ev({ seq: 2, kind: 'split', qty: 60, hash: 'h2', parents: [1] }),
    ev({ seq: 3, kind: 'split', qty: 41, hash: 'h3', parents: [1] }),
  ]);
  const res = runCli([file, '--now', '5000']);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /conservation violation/);
});

test('CLI: repo sample events.jsonl runs clean with --now 5000', () => {
  const sample = path.join(__dirname, '..', 'events.jsonl');
  const res = runCli([sample, '--now', '5000']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.chain.map((e) => e.seq), [1, 2, 3, 5]);
  assert.deepEqual(out.gaps.map((g) => g.seq), [4]);
});

test('CLI: output is deterministic across repeated runs', () => {
  const file = writeTmp([
    ev({ seq: 2, ts: 200, hash: 'h2' }),
    ev({ seq: 1, ts: 100, hash: 'h1' }),
  ]);
  const a = runCli([file, '--now', '5000']);
  const b = runCli([file, '--now', '5000']);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
});
