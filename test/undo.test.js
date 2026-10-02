'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { mkTmp, writeJournal, runCli } = require('./helper');
const { sha256, canonical, readJson } = require('../lib/util');

test('duplicate undo of same transaction takes effect once and leaves conflict marker', () => {
  const root = mkTmp('ledger-undo-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, [
    { id: 't1', account: 'cash', amount_cents: 10000 },
    { id: 'u1', undo: 't1' },
    { id: 'u2', undo: 't1' },
  ]);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  const r = runCli(['apply', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 0, r.stderr);

  const db = readJson(path.join(dir, 'db.json'));
  assert.strictEqual(db.accounts.cash, 0, 'undo applied exactly once');
  assert.strictEqual(db.conflicts.length, 1);
  assert.deepStrictEqual(db.conflicts[0], { row: 'u2', target: 't1', reason: 'duplicate-undo' });
  assert.ok(db.undone.t1, 'undo recorded');
  assert.strictEqual(db.undone.t1.by, 'u1');

  // re-apply is idempotent: conflict not duplicated, hash unchanged
  const before = sha256(canonical(db));
  const r2 = runCli(['apply', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const db2 = readJson(path.join(dir, 'db.json'));
  assert.strictEqual(db2.conflicts.length, 1);
  assert.strictEqual(sha256(canonical(db2)), before);
});

test('same transaction key: later write overrides earlier write; undo can point back', () => {
  const root = mkTmp('ledger-override-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, [
    { id: 't1', account: 'cash', amount_cents: 100 },
    { id: 't2', account: 'cash', amount_cents: 50 },
    { id: 't1', account: 'cash', amount_cents: 250 },
    { id: 'u1', undo: 't1' },
  ]);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  const r = runCli(['apply', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 0, r.stderr);
  const db = readJson(path.join(dir, 'db.json'));
  assert.strictEqual(db.accounts.cash, 50, 'override (250 replaces 100) then undo of t1 leaves only t2');
  assert.strictEqual(db.conflicts.length, 0);
});

test('undo of unknown transaction is a conflict, not an error', () => {
  const root = mkTmp('ledger-unknown-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, [
    { id: 't1', account: 'cash', amount_cents: 100 },
    { id: 'u9', undo: 'nope' },
  ]);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  assert.strictEqual(runCli(['apply', '--journal', journal, '--dir', dir]).status, 0);
  const db = readJson(path.join(dir, 'db.json'));
  assert.strictEqual(db.accounts.cash, 100);
  assert.deepStrictEqual(db.conflicts, [{ row: 'u9', target: 'nope', reason: 'unknown-txn' }]);
});
