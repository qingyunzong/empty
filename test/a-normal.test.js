'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

test('A: normal debit/credit/hold/release lifecycle', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', op: 'open', account: 'a', balance: 100 });
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 100, held: 0 });

  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 });
  assert.equal(ledger.getAccount('a').balance, 70);

  ledger.apply({ id: 'e3', op: 'credit', account: 'a', amount: 20 });
  assert.equal(ledger.getAccount('a').balance, 90);

  ledger.apply({ id: 'e4', op: 'hold', account: 'a', amount: 25 });
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 90, held: 25 });

  ledger.apply({ id: 'e5', op: 'release', account: 'a', amount: 10 });
  assert.equal(ledger.getAccount('a').held, 15);

  ledger.apply({ id: 'e6', op: 'release', account: 'a', amount: 15 });
  assert.equal(ledger.getAccount('a').held, 0);

  ledger.apply({ id: 'e7', op: 'commit', account: 'a' });
  assert.deepEqual(ledger.getAccount('a'), { state: 'COMMITTED', balance: 90, held: 0 });
  assert.equal(ledger.head, 'e7');
});

test('A: hold is frozen from available balance, void auto-releases', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', op: 'open', account: 'a', balance: 50 });
  ledger.apply({ id: 'e2', op: 'hold', account: 'a', amount: 50 });
  assert.throws(
    () => ledger.apply({ id: 'e3', op: 'debit', account: 'a', amount: 1 }),
    (err) => err.code === 'NEGATIVE',
  );
  // account is now ERROR; repair, then void path on a fresh ledger
  const ledger2 = new Ledger();
  ledger2.apply({ id: 'f1', op: 'open', account: 'a', balance: 50 });
  ledger2.apply({ id: 'f2', op: 'hold', account: 'a', amount: 20 });
  ledger2.apply({ id: 'f3', op: 'void', account: 'a' });
  assert.deepEqual(ledger2.getAccount('a'), { state: 'VOIDED', balance: 50, held: 0 });
});

test('A: commit with outstanding hold leaks -> HOLD_LEAK and ERROR', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', op: 'open', account: 'a', balance: 100 });
  ledger.apply({ id: 'e2', op: 'hold', account: 'a', amount: 10 });
  assert.throws(
    () => ledger.apply({ id: 'e3', op: 'commit', account: 'a' }),
    (err) => err.code === 'HOLD_LEAK',
  );
  assert.equal(ledger.getAccount('a').state, 'ERROR');
});
