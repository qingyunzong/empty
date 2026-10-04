'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

test('B: overdraft debit enters ERROR, only repair is accepted, then recovery', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', op: 'open', account: 'a', balance: 50 });

  assert.throws(
    () => ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 80 }),
    (err) => err.code === 'NEGATIVE',
  );
  assert.deepEqual(ledger.getAccount('a'), { state: 'ERROR', balance: 50, held: 0 });

  // while in ERROR every non-repair op is an illegal transition
  for (const [id, op] of [['e3', 'debit'], ['e4', 'credit'], ['e5', 'commit'], ['e6', 'open']]) {
    assert.throws(
      () => ledger.apply({ id, op, account: 'a', amount: 10, balance: 10 }),
      (err) => err.code === 'ILLEGAL_TRANSITION',
    );
    assert.equal(ledger.getAccount('a').state, 'ERROR');
  }

  ledger.apply({ id: 'e7', op: 'repair', account: 'a' });
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 50, held: 0 });

  ledger.apply({ id: 'e8', op: 'debit', account: 'a', amount: 40 });
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 10, held: 0 });
});

test('B: illegal transition from INIT and from COMMITTED enters ERROR', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.apply({ id: 'e1', op: 'debit', account: 'ghost', amount: 5 }),
    (err) => err.code === 'ILLEGAL_TRANSITION',
  );
  assert.equal(ledger.getAccount('ghost').state, 'ERROR');

  ledger.apply({ id: 'e2', op: 'open', account: 'a', balance: 10 });
  ledger.apply({ id: 'e3', op: 'commit', account: 'a' });
  assert.throws(
    () => ledger.apply({ id: 'e4', op: 'debit', account: 'a', amount: 1 }),
    (err) => err.code === 'ILLEGAL_TRANSITION',
  );
  assert.equal(ledger.getAccount('a').state, 'ERROR');
  ledger.apply({ id: 'e5', op: 'repair', account: 'a' });
  assert.equal(ledger.getAccount('a').state, 'OPEN');
});
