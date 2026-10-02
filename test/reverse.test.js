import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeDir, runCli, initLedger, appendTx } from './helpers.js';

test('normal reversal restores the account balance', () => {
  const dir = makeDir();
  initLedger(dir);
  appendTx(dir, { id: 'pay-1', amount: 250, account: 'alice', payloadHash: 'p1' });
  appendTx(dir, { id: 'pay-2', amount: -40, account: 'alice', payloadHash: 'p2' });
  const before = runCli(['verify'], { dir });
  assert.equal(before.json.accounts.alice, 210);

  const rev = runCli(['reverse', 'pay-1'], { dir });
  assert.equal(rev.status, 0);
  assert.equal(rev.json.tx.kind, 'REVERSAL');
  assert.equal(rev.json.tx.id, 'REV-pay-1');
  assert.equal(rev.json.tx.amount, -250);
  assert.equal(rev.json.tx.account, 'alice');
  assert.equal(
    rev.json.tx.payloadHash,
    createHash('sha256').update('reversal-of:pay-1', 'utf8').digest('hex'),
  );

  const after = runCli(['verify'], { dir });
  assert.equal(after.status, 0);
  assert.equal(after.json.accounts.alice, -40);
  assert.equal(after.json.height, 3);
});

test('duplicate reversal exits 4 with JSON stderr', () => {
  const dir = makeDir();
  initLedger(dir);
  appendTx(dir, { id: 't1', amount: 10, account: 'a', payloadHash: 'p' });
  const first = runCli(['reverse', 't1'], { dir });
  assert.equal(first.status, 0);
  const second = runCli(['reverse', 't1'], { dir });
  assert.equal(second.status, 4);
  assert.equal(second.errJson.error.code, 'DUPLICATE_REVERSAL');
  assert.equal(typeof second.errJson.error.message, 'string');
});

test('reversing a reversal exits 4', () => {
  const dir = makeDir();
  initLedger(dir);
  appendTx(dir, { id: 't1', amount: 10, account: 'a', payloadHash: 'p' });
  runCli(['reverse', 't1'], { dir });
  const res = runCli(['reverse', 'REV-t1'], { dir });
  assert.equal(res.status, 4);
  assert.equal(res.errJson.error.code, 'REVERSAL_CONFLICT');
});

test('reversing an unknown transaction exits 1', () => {
  const dir = makeDir();
  initLedger(dir);
  appendTx(dir, { id: 't1', amount: 10, account: 'a', payloadHash: 'p' });
  const res = runCli(['reverse', 'nope'], { dir });
  assert.equal(res.status, 1);
  assert.equal(res.errJson.error.code, 'TX_NOT_FOUND');
});
