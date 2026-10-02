'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmp, writeJournal, runCli } = require('./helper');
const { freshDb, adjustBalance } = require('../lib/core');
const { LedgerError } = require('../lib/util');

const BASE_ROWS = [
  { id: 't1', account: 'a', amount_cents: 100 },
  { id: 't2', account: 'b', amount_cents: 200 },
  { id: 't3', account: 'c', amount_cents: 300 },
  { id: 't4', account: 'd', amount_cents: 400 },
  { id: 't5', account: 'e', amount_cents: 500 },
];

function expectJsonError(stderr, code) {
  let parsed;
  try {
    parsed = JSON.parse(stderr);
  } catch {
    assert.fail('stderr is not JSON: ' + stderr);
  }
  assert.ok(parsed.error, 'stderr JSON must contain error object');
  assert.strictEqual(parsed.error.code, code);
  assert.ok(typeof parsed.error.message === 'string');
}

test('missing journal line -> exit 2 with JSON error on stderr', () => {
  const root = mkTmp('ledger-missing-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, BASE_ROWS);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  writeJournal(journal, BASE_ROWS.slice(0, 3)); // drop lines 4-5 without rescanning
  const r = runCli(['apply', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 2, 'expected exit 2, got ' + r.status + ' stderr=' + r.stderr);
  expectJsonError(r.stderr, 'missing-line');
});

test('bad row hash -> exit 2 with JSON error on stderr', () => {
  const root = mkTmp('ledger-badhash-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, BASE_ROWS);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  const tampered = BASE_ROWS.slice();
  tampered[1] = { id: 't2', account: 'b', amount_cents: 999 };
  writeJournal(journal, tampered); // modify line 2 without rescanning
  const r = runCli(['apply', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 2, 'expected exit 2, got ' + r.status);
  expectJsonError(r.stderr, 'bad-hash');
});

test('malformed JSON line -> exit 2 with JSON error', () => {
  const root = mkTmp('ledger-badjson-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  fs.writeFileSync(journal, '{"id":"t1","account":"a","amount_cents":100}\nnot-json\n');
  const r = runCli(['scan', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 2);
  expectJsonError(r.stderr, 'bad-json');
});

test('non-integer amount -> exit 2 with JSON error', () => {
  const root = mkTmp('ledger-badrow-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');
  writeJournal(journal, [{ id: 't1', account: 'a', amount_cents: 10.5 }]);
  const r = runCli(['scan', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 2);
  expectJsonError(r.stderr, 'bad-row');
});

test('missing journal file -> exit 2 with JSON error', () => {
  const root = mkTmp('ledger-nojournal-');
  const r = runCli(['scan', '--journal', path.join(root, 'nope.ndjson'), '--dir', path.join(root, 's')]);
  assert.strictEqual(r.status, 2);
  expectJsonError(r.stderr, 'missing-journal');
});

test('negative balance is an error', () => {
  const db = freshDb();
  adjustBalance(db, 'a', 100);
  assert.throws(() => adjustBalance(db, 'a', -150), (err) => {
    assert.ok(err instanceof LedgerError);
    assert.strictEqual(err.code, 'negative-balance');
    return true;
  });
});
