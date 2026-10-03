'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmp, writeFile, readJson, readLines, cli } = require('../testsupport/helpers');

const JE = `account 1001 "Cash";
account 2001 "Revenue";
period 2025-01 open;

template fee(rate) {
  account FEE "Fee Payable";
  post dr 1001 (event.amount * rate) cr FEE (event.amount * rate);
}

batch SALE in 2025-01 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
  use fee(0.01);
  balance dr == cr;
}
`;

const EVENTS = JSON.stringify([
  { type: 'sale', amount: 100.00 },
  { type: 'sale', amount: 20.50 },
  { type: 'sale', amount: 0.50 },
]);

test('acceptance 1: normal run of three batches', () => {
  const dir = mkTmp('je-normal-');
  const jeFile = writeFile(dir, 'batch.je', JE);
  const evFile = writeFile(dir, 'events.json', EVENTS);
  const db = path.join(dir, 'db');

  const r = cli(['run', jeFile, evFile, '--db', db]);
  assert.equal(r.status, 0, r.error && r.error.message);
  assert.match(r.stdout, /POSTED SALE#1/);
  assert.match(r.stdout, /POSTED SALE#2/);
  assert.match(r.stdout, /POSTED SALE#3/);

  const index = readJson(path.join(db, 'index.json'));
  // cash: 100.00+1.00 + 20.50+0.21 + 0.50+0.01 = 122.22
  assert.equal(index.balances['1001'], 12222);
  assert.equal(index.balances['2001'], -12100);
  assert.equal(index.balances['FEE'], -122);
  assert.deepEqual(index.batches, {
    'SALE#1': 'POSTED',
    'SALE#2': 'POSTED',
    'SALE#3': 'POSTED',
  });
  assert.equal(index.lastSeq, 6);

  // WAL only at BEGIN_BATCH, before each POST, after END_BATCH.
  const wal = readLines(path.join(db, 'wal.log')).map((l) => JSON.parse(l));
  const types = wal.map((w) => w.t);
  assert.deepEqual(types, [
    'BEGIN_BATCH', 'POST', 'POST', 'END_BATCH',
    'BEGIN_BATCH', 'POST', 'POST', 'END_BATCH',
    'BEGIN_BATCH', 'POST', 'POST', 'END_BATCH',
  ]);
  // every WAL POST is mirrored by a durable posting with the same seq
  const postings = readLines(path.join(db, 'postings.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(postings.map((p) => p.seq), [1, 2, 3, 4, 5, 6]);
});
