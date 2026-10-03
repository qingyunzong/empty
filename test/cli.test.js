import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// The CLI is exercised through its exported run(argv, env) entry point, which
// returns exactly what the process emits: {status, stdout, stderr}. (The
// sandbox here blocks nested process spawning, and run() keeps the process
// wrapper in src/cli.js thin: it just writes the streams and exits.)

function freshDb() {
  return join(mkdtempSync(join(tmpdir(), 'budget-cli-')), 'budget.json');
}

test('happy path: set-budget, settle, available, cancel', () => {
  const db = freshDb();
  let r = run(['--db', db, 'set-budget', '--category', 'ops', '--limit', '100']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, category: 'ops', limit: 100 });

  r = run(['--db', db, 'settle', '--category', 'ops', '--amount', '60', '--id', 's1']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { ok: true, id: 's1', category: 'ops', amount: 60, status: 'settled' });

  r = run(['--db', db, 'available', 'ops']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { category: 'ops', available: 40, used: 60, limit: 100 });

  r = run(['--db', db, 'cancel', '--id', 's1']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, id: 's1', status: 'cancelled' });

  r = run(['--db', db, 'available', 'ops']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout),
    { category: 'ops', available: 100, used: 0, limit: 100 });
});

test('E_BUDGET: overspending exits non-zero with JSON error', () => {
  const db = freshDb();
  run(['--db', db, 'set-budget', '--category', 'ops', '--limit', '100']);
  run(['--db', db, 'settle', '--category', 'ops', '--amount', '60']);
  const r = run(['--db', db, 'settle', '--category', 'ops', '--amount', '50']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  const err = JSON.parse(r.stderr);
  assert.equal(err.error, 'E_BUDGET');
});

test('E_NOT_FOUND: cancelling a missing settlement', () => {
  const db = freshDb();
  const r = run(['--db', db, 'cancel', '--id', 'nope']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'E_NOT_FOUND');
});

test('E_USAGE: unknown command and bad amount exit non-zero with JSON', () => {
  const db = freshDb();
  let r = run(['--db', db, 'frobnicate']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'E_USAGE');

  r = run(['--db', db, 'settle', '--category', 'ops', '--amount', 'abc']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'E_USAGE');
});

test('E_STORAGE: corrupt JSON data file exits non-zero with JSON error', () => {
  const db = freshDb();
  writeFileSync(db, '{not valid json');
  const r = run(['--db', db, 'available', 'ops']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'E_STORAGE');
});

test('boundary: two 50s then a third is rejected, all via CLI', () => {
  const db = freshDb();
  run(['--db', db, 'set-budget', '--category', 'ops', '--limit', '100']);
  assert.equal(run(['--db', db, 'settle', '--category', 'ops', '--amount', '50']).status, 0);
  assert.equal(run(['--db', db, 'settle', '--category', 'ops', '--amount', '50']).status, 0);
  const r = run(['--db', db, 'settle', '--category', 'ops', '--amount', '1']);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stderr).error, 'E_BUDGET');
});
