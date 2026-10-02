'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJournal, runCli } = require('./helpers');

test('missing line (blank) in journal: exit 2, JSON error on stderr', () => {
  const dir = makeTmpDir('err-blank-');
  const j = path.join(dir, 'journal.ndjson');
  fs.writeFileSync(j, '{"seq":1,"txId":"a","op":"credit","account":"x","amount":1}\n\n{"seq":3,"txId":"b","op":"credit","account":"x","amount":2}\n');
  const r = runCli(['scan', '--journal', j, '--snapshot', path.join(dir, 's'), '--changeset', path.join(dir, 'c')]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stdout, '');
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'MISSING_LINE');
  assert.equal(err.error.details.line, 2);
});

test('missing line (seq gap) in journal: exit 2, JSON error on stderr', () => {
  const dir = makeTmpDir('err-gap-');
  const j = writeJournal(dir, [
    { seq: 1, txId: 'a', op: 'credit', account: 'x', amount: 1 },
    { seq: 3, txId: 'b', op: 'credit', account: 'x', amount: 2 },
  ]);
  const r = runCli(['scan', '--journal', j, '--snapshot', path.join(dir, 's'), '--changeset', path.join(dir, 'c')]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'MISSING_LINE');
  assert.equal(err.error.details.expected, 2);
  assert.equal(err.error.details.got, 3);
});

test('bad hash in changeset: exit 2, JSON error on stderr', () => {
  const dir = makeTmpDir('err-hash-');
  const j = writeJournal(dir, [
    { seq: 1, txId: 'a', op: 'credit', account: 'x', amount: 100 },
  ]);
  const cs = path.join(dir, 'cs.json');
  assert.equal(runCli(['scan', '--journal', j, '--snapshot', path.join(dir, 's'), '--changeset', cs]).status, 0);
  const changeset = JSON.parse(fs.readFileSync(cs, 'utf8'));
  changeset.entries[0].record.amount = 999999; // tamper: hash no longer matches
  fs.writeFileSync(cs, JSON.stringify(changeset));
  const r = runCli(['apply', '--changeset', cs, '--db', path.join(dir, 'db'), '--checkpoint', path.join(dir, 'cp')]);
  assert.equal(r.status, 2, r.stdout);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'HASH_MISMATCH');
  assert.equal(err.error.details.txId, 'a');
});

test('missing changeset file: exit 2, JSON error on stderr', () => {
  const dir = makeTmpDir('err-nocs-');
  const r = runCli(['apply', '--changeset', path.join(dir, 'nope.json'), '--db', path.join(dir, 'db'), '--checkpoint', path.join(dir, 'cp')]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'CHANGESET_NOT_FOUND');
});

test('cert without checkpoint: exit 2, JSON error on stderr', () => {
  const dir = makeTmpDir('err-nocp-');
  const r = runCli(['cert', '--checkpoint', path.join(dir, 'cp'), '--db', path.join(dir, 'db'), '--cert', path.join(dir, 'cert')]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'NO_CHECKPOINT');
});
