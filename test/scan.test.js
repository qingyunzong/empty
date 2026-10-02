'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJournal, runCli } = require('./helpers');

test('scan captures add/modify/delete as changeset', () => {
  const dir = makeTmpDir('scan-');
  const snap = path.join(dir, 'snap.json');
  const cs = path.join(dir, 'cs.json');

  const j1 = writeJournal(dir, [
    { seq: 1, txId: 'a', op: 'credit', account: 'x', amount: 100 },
    { seq: 2, txId: 'b', op: 'credit', account: 'y', amount: 200 },
    { seq: 3, txId: 'c', op: 'debit', account: 'x', amount: 50 },
  ]);
  let r = runCli(['scan', '--journal', j1, '--snapshot', snap, '--changeset', cs]);
  assert.equal(r.status, 0, r.stderr);
  let summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.added, summary.modified, summary.deleted], [3, 0, 0]);
  let changeset = JSON.parse(fs.readFileSync(cs, 'utf8'));
  assert.equal(changeset.entries.length, 3);
  assert.ok(changeset.entries.every((e) => e.type === 'add'));

  // second night: line 2 modified in place, line 3 replaced (modify), line 4 added
  const j2 = writeJournal(dir, [
    { seq: 1, txId: 'a', op: 'credit', account: 'x', amount: 100 },
    { seq: 2, txId: 'b', op: 'credit', account: 'y', amount: 250 },
    { seq: 3, txId: 'd', op: 'credit', account: 'z', amount: 10 },
    { seq: 4, txId: 'e', op: 'debit', account: 'z', amount: 5 },
  ]);
  r = runCli(['scan', '--journal', j2, '--snapshot', snap, '--changeset', cs]);
  assert.equal(r.status, 0, r.stderr);
  summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.added, summary.modified, summary.deleted], [1, 2, 0]);
  changeset = JSON.parse(fs.readFileSync(cs, 'utf8'));
  assert.equal(changeset.entries.filter((e) => e.type === 'modify')[0].txId, 'b');

  // third night: journal truncated to 2 lines -> delete of lines 3,4
  const j3 = writeJournal(dir, [
    { seq: 1, txId: 'a', op: 'credit', account: 'x', amount: 100 },
    { seq: 2, txId: 'b', op: 'credit', account: 'y', amount: 250 },
  ]);
  r = runCli(['scan', '--journal', j3, '--snapshot', snap, '--changeset', cs]);
  assert.equal(r.status, 0, r.stderr);
  summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.added, summary.modified, summary.deleted], [0, 0, 2]);
  changeset = JSON.parse(fs.readFileSync(cs, 'utf8'));
  const dels = changeset.entries.filter((e) => e.type === 'delete');
  assert.deepEqual(dels.map((d) => d.txId).sort(), ['d', 'e']);

  // no-op scan produces empty changeset
  r = runCli(['scan', '--journal', j3, '--snapshot', snap, '--changeset', cs]);
  summary = JSON.parse(r.stdout);
  assert.equal(summary.entries, 0);
});
