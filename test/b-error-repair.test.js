'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { ERR } = require('../src/core');

test('B: overdraft debit enters ERROR, repair recovers', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 50 });

  const bad = ledger.apply({ id: 'e2', type: 'debit', account: 'a', amount: 80 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, ERR.NEGATIVE);
  assert.equal(ledger.summary().a.status, 'ERROR');
  assert.equal(ledger.summary().a.balance, 50); // unchanged

  // while in ERROR only repair is accepted
  const rejected = ledger.apply({ id: 'e3', type: 'credit', account: 'a', amount: 5 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, ERR.ILLEGAL_TRANSITION);
  assert.equal(ledger.summary().a.balance, 50);

  const fixed = ledger.apply({ id: 'e4', type: 'repair', account: 'a' });
  assert.equal(fixed.ok, true);
  assert.equal(ledger.summary().a.status, 'ACTIVE');

  ledger.apply({ id: 'e5', type: 'debit', account: 'a', amount: 20 });
  assert.deepEqual(ledger.summary().a, { status: 'ACTIVE', balance: 30, frozen: 0 });
});

test('B: illegal lifecycle transitions enter ERROR, repair restores prior state', () => {
  const ledger = new Ledger();

  // debit before open
  const r1 = ledger.apply({ id: 'e1', type: 'debit', account: 'a', amount: 1 });
  assert.equal(r1.code, ERR.ILLEGAL_TRANSITION);
  assert.equal(ledger.summary().a.status, 'ERROR');
  ledger.apply({ id: 'e2', type: 'repair', account: 'a' });
  assert.equal(ledger.summary().a.status, 'INIT'); // restored to pre-error state

  ledger.apply({ id: 'e3', type: 'open', account: 'a', amount: 10 });
  ledger.apply({ id: 'e4', type: 'commit', account: 'a' });

  // debit after commit
  const r2 = ledger.apply({ id: 'e5', type: 'debit', account: 'a', amount: 1 });
  assert.equal(r2.code, ERR.ILLEGAL_TRANSITION);
  assert.equal(ledger.summary().a.status, 'ERROR');
  ledger.apply({ id: 'e6', type: 'repair', account: 'a' });
  assert.equal(ledger.summary().a.status, 'COMMITTED');
});

test('B: HOLD_LEAK on over-release, commit/void with outstanding holds', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 100 });
  ledger.apply({ id: 'e2', type: 'hold', account: 'a', amount: 30 });

  const r1 = ledger.apply({ id: 'e3', type: 'release', account: 'a', amount: 31 });
  assert.equal(r1.code, ERR.HOLD_LEAK);
  assert.equal(ledger.summary().a.status, 'ERROR');
  ledger.apply({ id: 'e4', type: 'repair', account: 'a' });

  const r2 = ledger.apply({ id: 'e5', type: 'commit', account: 'a' });
  assert.equal(r2.code, ERR.HOLD_LEAK);
  ledger.apply({ id: 'e6', type: 'repair', account: 'a' });

  const r3 = ledger.apply({ id: 'e7', type: 'void', account: 'a' });
  assert.equal(r3.code, ERR.HOLD_LEAK);
  ledger.apply({ id: 'e8', type: 'repair', account: 'a' });

  ledger.apply({ id: 'e9', type: 'release', account: 'a', amount: 30 });
  ledger.apply({ id: 'e10', type: 'commit', account: 'a' });
  assert.equal(ledger.summary().a.status, 'COMMITTED');
});
