import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

// In-process CLI harness (the sandbox forbids spawning child processes).
function run(args) {
  const out = [];
  const err = [];
  const status = runCli(args, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function fixture(dir, name, events) {
  const p = join(dir, name);
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

test('CLI: load then query returns balance and limit usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auditdb-'));
  const db = join(dir, 'store.jsonl');
  const f = fixture(dir, 'in.jsonl', [
    { id: 'e1', account: 'acc', validFrom: '2024-01-01T00:00:00Z', validTo: null, txSeq: 1,
      payload: { amount: 100, limit: 40 } },
    { id: 'e2', account: 'acc', validFrom: '2024-02-01T00:00:00Z', validTo: null, txSeq: 2,
      payload: { amount: -30, limit: 10 } },
  ]);

  const load = run(['load', f, '--db', db]);
  assert.equal(load.status, 0, load.stderr);
  assert.deepEqual(JSON.parse(load.stdout), { loaded: 2, total: 2, db });

  const q = run(['query', 'acc', '--valid', '2024-03-01T00:00:00Z', '--tx', '2', '--db', db]);
  assert.equal(q.status, 0, q.stderr);
  const out = JSON.parse(q.stdout);
  assert.equal(out.balance, 70);
  assert.equal(out.limit, 50);
  assert.equal(out.count, 2);

  // asOf tx 1 sees only the first version.
  const q1 = run(['query', 'acc', '--valid', '2024-03-01T00:00:00Z', '--tx', '1', '--db', db]);
  assert.equal(JSON.parse(q1.stdout).balance, 100);

  // Second load appends a correction to the same store.
  const f2 = fixture(dir, 'in2.jsonl', [
    { id: 'e3', account: 'acc', validFrom: '2024-01-15T00:00:00Z', validTo: null, txSeq: 3,
      payload: { amount: 5 }, supersedes: 'e1' },
  ]);
  assert.equal(run(['load', f2, '--db', db]).status, 0);
  const q3 = run(['query', 'acc', '--valid', '2024-03-01T00:00:00Z', '--tx', '3', '--db', db]);
  assert.equal(JSON.parse(q3.stdout).balance, -25); // 5 + (-30)
  assert.equal(readFileSync(db, 'utf8').trim().split('\n').length, 3);
});

test('CLI: E_TIME_ORDER exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auditdb-'));
  const f = fixture(dir, 'bad.jsonl', [
    { id: 'e1', account: 'acc', validFrom: '2024-05-01T00:00:00Z',
      validTo: '2024-01-01T00:00:00Z', txSeq: 1 },
  ]);
  const r = run(['load', f, '--db', join(dir, 's.jsonl')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_TIME_ORDER/);
});

test('CLI: E_TOMBSTONE exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auditdb-'));
  const f = fixture(dir, 'bad.jsonl', [
    { id: 'e1', account: 'acc', validFrom: '2024-01-01T00:00:00Z', validTo: null, txSeq: 1 },
    { id: 'd1', account: 'acc', validFrom: '2024-01-01T00:00:00Z', validTo: null, txSeq: 2,
      supersedes: 'e1', tombstone: true },
    { id: 'e2', account: 'acc', validFrom: '2024-01-01T00:00:00Z', validTo: null, txSeq: 3,
      supersedes: 'd1' },
  ]);
  const r = run(['load', f, '--db', join(dir, 's.jsonl')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /E_TOMBSTONE/);
});

test('CLI: usage errors exit non-zero', () => {
  assert.notEqual(run(['load']).status, 0);
  assert.notEqual(run(['query', 'acc']).status, 0);
  assert.notEqual(run(['nonsense']).status, 0);
  assert.equal(run([]).status, 0); // bare help
});
