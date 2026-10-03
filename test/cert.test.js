'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { project, projectionOf } = require('../lib/model');
const { cert } = require('../lib/cert');

const LOG = [
  { type: 'sale', id: 's1', account: 'A', amount: 10 },
  { type: 'sale', id: 's2', account: 'B', amount: 6 },
  { type: 'freeze', account: 'A', amount: 2 },
  { type: 'refund', id: 'r1', ref: 's1', amount: 4 },
  { type: 'refund', id: 'r2', ref: 's1', amount: 1 },
  { type: 'refundVoid', ref: 'r2' },
  { type: 'unfreeze', account: 'B', amount: 3 },
];

// Fully independent offline recomputation: folds the log by hand and hashes
// with raw crypto, sharing no code with lib/model or lib/cert.
function offlineCert(events) {
  const accounts = {};
  const sales = {};
  const refunds = {};
  let seq = 0;
  const acc = (id) => (accounts[id] = accounts[id] || { balance: 0, frozen: 0 });
  for (const e of events) {
    seq += 1;
    if (e.type === 'sale') {
      acc(e.account).balance += e.amount;
      acc(e.account).frozen += e.amount;
      sales[e.id] = { account: e.account, amount: e.amount, refunded: 0 };
    } else if (e.type === 'freeze') {
      acc(e.account).balance -= e.amount;
      acc(e.account).frozen += e.amount;
    } else if (e.type === 'unfreeze') {
      acc(e.account).frozen -= e.amount;
      acc(e.account).balance += e.amount;
    } else if (e.type === 'refund') {
      const s = sales[e.ref];
      acc(s.account).balance -= e.amount;
      acc(s.account).frozen -= e.amount;
      s.refunded += e.amount;
      refunds[e.id] = { saleId: e.ref, account: s.account, amount: e.amount, voided: false };
    } else if (e.type === 'refundVoid') {
      const r = refunds[e.ref];
      acc(r.account).balance += r.amount;
      acc(r.account).frozen += r.amount;
      sales[r.saleId].refunded -= r.amount;
      r.voided = true;
    }
  }
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const names = Object.keys(accounts).sort();
  const perAccount = {};
  for (const n of names) {
    perAccount[n] = sha(`${n}|${accounts[n].balance}|${accounts[n].frozen}`);
  }
  return {
    seq,
    perAccount,
    overall: sha(names.map((n) => perAccount[n]).join('') + `|seq:${seq}`),
  };
}

test('terminal cert is recomputable offline from the event log', () => {
  const c = cert(project(LOG));
  const offline = offlineCert(LOG);
  assert.equal(c.seq, offline.seq);
  assert.equal(c.overall, offline.overall);
  for (const name of Object.keys(offline.perAccount)) {
    assert.equal(c.accounts[name].hash, offline.perAccount[name], `account ${name} hash mismatch`);
    assert.deepEqual(
      { balance: c.accounts[name].balance, frozen: c.accounts[name].frozen },
      projectionOf(project(LOG)).accounts[name],
    );
  }
});

test('cert is deterministic and sensitive to any state change', () => {
  const c1 = cert(project(LOG));
  const c2 = cert(project(LOG));
  assert.deepEqual(c1, c2);
  const tampered = cert(project([...LOG, { type: 'freeze', account: 'A', amount: 1 }]));
  assert.notEqual(tampered.overall, c1.overall);
  assert.notEqual(tampered.accounts.A.hash, c1.accounts.A.hash);
  assert.equal(tampered.accounts.B.hash, c1.accounts.B.hash, 'untouched account hash stays stable');
});
