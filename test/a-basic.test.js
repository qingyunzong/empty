'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

test('A: normal debit/credit/hold/release lifecycle', () => {
  const ledger = new Ledger();
  assert.equal(ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 100 }).ok, true);
  assert.equal(ledger.apply({ id: 'e2', type: 'debit', account: 'a', amount: 40 }).ok, true);
  assert.equal(ledger.apply({ id: 'e3', type: 'credit', account: 'a', amount: 10 }).ok, true);
  assert.equal(ledger.apply({ id: 'e4', type: 'hold', account: 'a', amount: 25 }).ok, true);
  assert.equal(ledger.apply({ id: 'e5', type: 'release', account: 'a', amount: 15 }).ok, true);

  assert.deepEqual(ledger.summary().a, { status: 'ACTIVE', balance: 70, frozen: 10 });
  assert.deepEqual(ledger.errors, []);

  // hold limited by available balance (70 - 10 = 60)
  assert.equal(ledger.apply({ id: 'e6', type: 'hold', account: 'a', amount: 60 }).ok, true);
  assert.deepEqual(ledger.summary().a, { status: 'ACTIVE', balance: 70, frozen: 70 });

  // duplicate event id is idempotent
  const dup = ledger.apply({ id: 'e3', type: 'credit', account: 'a', amount: 10 });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(ledger.summary().a.balance, 70);
});

test('A: commit and void close the account cleanly', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 5 });
  ledger.apply({ id: 'e2', type: 'commit', account: 'a' });
  assert.equal(ledger.summary().a.status, 'COMMITTED');

  ledger.apply({ id: 'e3', type: 'open', account: 'b', amount: 7 });
  ledger.apply({ id: 'e4', type: 'void', account: 'b' });
  assert.equal(ledger.summary().b.status, 'VOID');
});
