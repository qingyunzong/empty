import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LeaseStore } from '../src/store.js';
import { cli, jsonl, join, claim } from './helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agv-audit-'));
}

const CLEAN = [
  join('a1'), join('a2'),
  claim('t1', 'a1', 1, 0, 100, { s: 1 }),
  claim('t2', 'a2', 1, 1, 100, { s: 2 }),
  { type: 'complete', task: 't1', agv: 'a1', time: 50 },
];

test('audit: clean log passes with exit 0', () => {
  const input = CLEAN.map((e) => JSON.stringify(e)).join('\n');
  const r = cli(['audit', '-'], input);
  assert.equal(r.code, 0);
  const lines = jsonl(r.stdout);
  const summary = lines.at(-1);
  assert.equal(summary.type, 'audit');
  assert.equal(summary.ok, true);
  assert.equal(summary.violations, 0);
  assert.ok(summary.checks > 0);
});

test('audit: store/replay mismatch reports violation with exit 1', () => {
  const dir = tmpdir();
  const store = new LeaseStore(dir);
  store.commit({
    version: 1,
    fencing: { t1: 7 },
    leases: { t1: { owner: 'ghost', epoch: 7, leaseStart: 0, leaseExpiry: 100 } },
  });
  const input = CLEAN.map((e) => JSON.stringify(e)).join('\n');
  const r = cli(['audit', '-', '--store', dir], input);
  assert.equal(r.code, 1);
  const lines = jsonl(r.stdout);
  assert.equal(lines[0].type, 'violation');
  assert.equal(lines[0].invariant, 'store-matches-replay');
  assert.equal(lines.at(-1).ok, false);
});

test('audit: matching store passes', () => {
  const dir = tmpdir();
  const store = new LeaseStore(dir);
  store.commit({
    version: 1,
    fencing: { t2: 1 },
    leases: { t2: { owner: 'a2', epoch: 1, leaseStart: 1, leaseExpiry: 101 } },
  });
  const input = CLEAN.map((e) => JSON.stringify(e)).join('\n');
  const r = cli(['audit', '-', '--store', dir], input);
  assert.equal(r.code, 0);
});

test('audit: corrupt store exits 9', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'lease.json'), 'not json');
  const r = cli(['audit', '-', '--store', dir], JSON.stringify(join('a1')));
  assert.equal(r.code, 9);
});

test('replay cli: deterministic JSONL output across runs', () => {
  const input = CLEAN.map((e) => JSON.stringify(e)).join('\n');
  const r1 = cli(['replay', '-'], input);
  const r2 = cli(['replay', '-'], input);
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, r2.stdout);
  const lines = jsonl(r1.stdout);
  assert.equal(lines.at(-1).type, 'summary');
  assert.equal(lines.at(-1).completed, 1);
  assert.equal(lines.at(-1).claimed, 1);
});

test('cli: usage errors exit 2', () => {
  assert.equal(cli(['nope']).code, 2);
  assert.equal(cli(['lease', '--task', 't1']).code, 2);
});
