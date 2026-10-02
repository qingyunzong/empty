'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJournal, runCli } = require('./helpers');

function setup(dir, records, batch) {
  const journal = writeJournal(dir, records);
  const snap = path.join(dir, 'snap.json');
  const cs = path.join(dir, 'cs.json');
  const db = path.join(dir, 'db.json');
  const cp = path.join(dir, 'cp.json');
  const cert = path.join(dir, 'cert.json');
  assert.equal(runCli(['scan', '--journal', journal, '--snapshot', snap, '--changeset', cs]).status, 0);
  const args = ['apply', '--changeset', cs, '--db', db, '--checkpoint', cp, '--cert', cert];
  if (batch) args.push('--batch', String(batch));
  return { args, db, cp, cert, cs };
}

test('apply is idempotent: re-apply yields identical db hash', () => {
  const dir = makeTmpDir('apply-idem-');
  const { args, db } = setup(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 1000 },
    { seq: 2, txId: 't2', op: 'debit', account: 'a', amount: 300 },
  ], 1);
  assert.equal(runCli(args).status, 0);
  const first = fs.readFileSync(db, 'utf8');
  assert.equal(runCli(args).status, 0);
  const second = fs.readFileSync(db, 'utf8');
  assert.equal(first, second);
  const state = JSON.parse(second).state;
  assert.equal(state.balances.a, 700);
});

test('same tx key: later write overrides earlier write', () => {
  const dir = makeTmpDir('apply-lww-');
  const { args, db } = setup(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 100 },
    { seq: 2, txId: 't1', op: 'credit', account: 'a', amount: 999 },
  ]);
  assert.equal(runCli(args).status, 0);
  const state = JSON.parse(fs.readFileSync(db, 'utf8')).state;
  assert.equal(state.balances.a, 999);
});

test('duplicate undo of same transaction applies once and leaves conflict marker', () => {
  const dir = makeTmpDir('apply-dupundo-');
  const { args, db } = setup(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 500 },
    { seq: 2, txId: 't2', op: 'credit', account: 'a', amount: 700 },
    { seq: 3, txId: 'u1', op: 'undo', ref: 't1' },
    { seq: 4, txId: 'u2', op: 'undo', ref: 't1' },
  ]);
  assert.equal(runCli(args).status, 0);
  const state = JSON.parse(fs.readFileSync(db, 'utf8')).state;
  assert.equal(state.balances.a, 700, 't1 undone exactly once');
  assert.deepEqual(state.undone, ['t1']);
  const dup = state.conflicts.filter((c) => c.code === 'DUPLICATE_UNDO');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].txId, 'u2');
  assert.equal(dup[0].ref, 't1');
});

test('undo can point back across batches', () => {
  const dir = makeTmpDir('apply-xbatch-');
  const { args, db } = setup(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 500 },
    { seq: 2, txId: 't2', op: 'credit', account: 'b', amount: 100 },
    { seq: 3, txId: 'u1', op: 'undo', ref: 't1' },
  ], 1);
  assert.equal(runCli(args).status, 0);
  const state = JSON.parse(fs.readFileSync(db, 'utf8')).state;
  assert.equal(state.balances.a, undefined);
  assert.equal(state.balances.b, 100);
});

test('negative balance is an error: exit 2 with JSON stderr', () => {
  const dir = makeTmpDir('apply-neg-');
  const { args } = setup(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 100 },
    { seq: 2, txId: 't2', op: 'debit', account: 'a', amount: 150 },
  ]);
  const r = runCli(args);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const err = JSON.parse(r.stderr);
  assert.equal(err.error.code, 'NEGATIVE_BALANCE');
  assert.equal(err.error.details.account, 'a');
  assert.equal(err.error.details.balance, -50);
});

test('non-integer amount is rejected', () => {
  const dir = makeTmpDir('apply-amt-');
  const journal = writeJournal(dir, [
    { seq: 1, txId: 't1', op: 'credit', account: 'a', amount: 10.5 },
  ]);
  const r = runCli(['scan', '--journal', journal, '--snapshot', path.join(dir, 's'), '--changeset', path.join(dir, 'c')]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).error.code, 'INVALID_AMOUNT');
});
