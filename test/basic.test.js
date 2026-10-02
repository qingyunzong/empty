import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDir, runCli, initLedger, appendTx } from './helpers.js';

test('init creates an empty ledger and verify reports height 0', () => {
  const dir = makeDir();
  const init = initLedger(dir);
  assert.equal(init.status, 0);
  assert.equal(init.json.ok, true);
  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 0);
  assert.deepEqual(verify.json.accounts, {});
  assert.equal(verify.json.height, 0);
  assert.equal(verify.json.head, null);
});

test('append validates parent: auto-fill when omitted, reject mismatch', () => {
  const dir = makeDir();
  initLedger(dir);
  const first = appendTx(dir, { id: 't1', amount: 10, account: 'a', payloadHash: 'p1' });
  assert.equal(first.status, 0);
  assert.equal(first.json.tx.parent, null);

  const wrongParent = appendTx(dir, {
    id: 't2', amount: 5, account: 'a', payloadHash: 'p2', parent: 'deadbeef',
  });
  assert.equal(wrongParent.status, 1);
  assert.equal(wrongParent.errJson.error.code, 'PARENT_MISMATCH');

  const ok = appendTx(dir, {
    id: 't2', amount: 5, account: 'a', payloadHash: 'p2', parent: first.json.hash,
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.json.tx.parent, first.json.hash);
});

test('append rejects malformed transactions and duplicate ids', () => {
  const dir = makeDir();
  initLedger(dir);
  appendTx(dir, { id: 't1', amount: 1, account: 'a', payloadHash: 'p' });
  const dup = appendTx(dir, { id: 't1', amount: 2, account: 'a', payloadHash: 'p' });
  assert.equal(dup.status, 1);
  assert.equal(dup.errJson.error.code, 'DUPLICATE_ID');
  const badAmount = appendTx(dir, { id: 't2', amount: 'x', account: 'a', payloadHash: 'p' });
  assert.equal(badAmount.status, 1);
  assert.equal(badAmount.errJson.error.code, 'INVALID_TX');
  const badKind = appendTx(dir, { id: 't3', amount: 1, account: 'a', kind: 'WEIRD', payloadHash: 'p' });
  assert.equal(badKind.status, 1);
  assert.equal(badKind.errJson.error.code, 'INVALID_TX');
});

test('verify detects a tampered transaction file', () => {
  const dir = makeDir();
  initLedger(dir);
  const res = appendTx(dir, { id: 't1', amount: 7, account: 'a', payloadHash: 'p' });
  assert.equal(res.status, 0);
  fs.writeFileSync(
    `${dir}/txs/${res.json.hash}.json`,
    '{"account":"a","amount":8,"id":"t1","kind":"NORMAL","parent":null,"payloadHash":"p"}\n',
  );
  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 1);
  assert.equal(verify.errJson.error.code, 'CHAIN_CORRUPT');
});
