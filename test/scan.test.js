'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmp, writeJournal, runCli } = require('./helper');
const { sha256, readJson } = require('../lib/util');
const { merkleRoot } = require('../lib/core');

test('scan captures add/modify/delete as a changeset; apply is idempotent', () => {
  const root = mkTmp('ledger-scan-');
  const journal = path.join(root, 'journal.ndjson');
  const dir = path.join(root, 'state');

  writeJournal(journal, [
    { id: 't1', account: 'a', amount_cents: 100 },
    { id: 't2', account: 'b', amount_cents: 200 },
    { id: 't3', account: 'c', amount_cents: 300 },
  ]);
  let r = runCli(['scan', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).events, 3);
  assert.strictEqual(runCli(['apply', '--journal', journal, '--dir', dir]).status, 0);
  let db = readJson(path.join(dir, 'db.json'));
  assert.deepStrictEqual(db.accounts, { a: 100, b: 200, c: 300 });

  // modify line 2, delete line 3
  writeJournal(journal, [
    { id: 't1', account: 'a', amount_cents: 100 },
    { id: 't2', account: 'b', amount_cents: 250 },
  ]);
  r = runCli(['scan', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 0, r.stderr);
  const changeset = fs.readFileSync(path.join(dir, 'changeset.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(changeset.map((e) => e.op), ['modify', 'delete']);
  assert.strictEqual(runCli(['apply', '--journal', journal, '--dir', dir]).status, 0);
  db = readJson(path.join(dir, 'db.json'));
  assert.deepStrictEqual(db.accounts, { a: 100, b: 250, c: 0 });

  // append line 3
  writeJournal(journal, [
    { id: 't1', account: 'a', amount_cents: 100 },
    { id: 't2', account: 'b', amount_cents: 250 },
    { id: 't4', account: 'a', amount_cents: 40 },
  ]);
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);
  assert.strictEqual(runCli(['apply', '--journal', journal, '--dir', dir]).status, 0);
  db = readJson(path.join(dir, 'db.json'));
  assert.deepStrictEqual(db.accounts, { a: 140, b: 250, c: 0 });

  // checkpoint records committed position, row hash, batch count
  const ck = readJson(path.join(dir, 'checkpoint.json'));
  assert.strictEqual(ck.committedSeq, 1);
  assert.strictEqual(ck.batch, 1);
  assert.ok(typeof ck.rowHash === 'string' && ck.rowHash.length === 64);

  // cert: merkle root over journal line hashes, coverage interval [1, 3]
  r = runCli(['cert', '--journal', journal, '--dir', dir]);
  assert.strictEqual(r.status, 0, r.stderr);
  const cert = JSON.parse(r.stdout);
  const lines = fs.readFileSync(journal, 'utf8').trim().split('\n');
  const leaves = lines.map((l) => sha256(l));
  assert.strictEqual(cert.merkleRoot, merkleRoot(leaves));
  assert.strictEqual(cert.from, 1);
  assert.strictEqual(cert.to, 3);
  assert.ok(cert.batches >= 1);
});
