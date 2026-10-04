'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

function openWith(balance) {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', op: 'open', account: 'a', balance });
  return ledger;
}

test('undo applies the inverse command of the target event', () => {
  const ledger = openWith(100);
  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 });
  ledger.apply({ id: 'e3', op: 'credit', account: 'a', amount: 10 });
  assert.equal(ledger.getAccount('a').balance, 80);

  const plan = ledger.undoPlan('e3');
  assert.deepEqual(plan, [{ op: 'debit', account: 'a', amount: 10, undoes: 'e3' }]);

  const res = ledger.apply({ id: 'u1', op: 'undo', account: 'a', target: 'e3' });
  assert.equal(res.ok, true);
  assert.equal(ledger.getAccount('a').balance, 70);
  assert.equal(ledger.head, 'u1');
});

test('undo of a non-head event on the same account reports a conflict witness path', () => {
  const ledger = openWith(100);
  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 });
  ledger.apply({ id: 'e3', op: 'credit', account: 'a', amount: 10 });

  assert.throws(
    () => ledger.undoPlan('e2'),
    (err) => {
      assert.equal(err.code, 'FORK_CONFLICT');
      assert.deepEqual(err.details.witness.path, ['e2', 'e3']);
      assert.deepEqual(err.details.witness.conflicts, ['e3']);
      return true;
    },
  );
  // failed undo must not silently mutate anything
  assert.equal(ledger.getAccount('a').balance, 80);
  assert.equal(ledger.head, 'e3');
});

test('undo across a fork reports the divergence witness instead of failing silently', () => {
  const ledger = openWith(100);
  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 10, parent: 'e1' });
  ledger.apply({ id: 'e3', op: 'open', account: 'b', balance: 0, parent: 'e1' }); // branch off e1
  ledger.apply({ id: 'e4', op: 'credit', account: 'b', amount: 5, parent: 'e3' }); // head on the b-branch

  assert.throws(
    () => ledger.undoPlan('e2'),
    (err) => {
      assert.equal(err.code, 'FORK_CONFLICT');
      assert.equal(err.details.witness.fork, 'e1');
      assert.deepEqual(err.details.witness.headPath, ['e4', 'e3', 'e1']);
      assert.deepEqual(err.details.witness.targetPath, ['e2', 'e1']);
      return true;
    },
  );
});

test('undo of commit/void reopens the account; open is not undoable', () => {
  const ledger = openWith(50);
  ledger.apply({ id: 'e2', op: 'commit', account: 'a' });
  assert.equal(ledger.getAccount('a').state, 'COMMITTED');
  ledger.apply({ id: 'u1', op: 'undo', account: 'a', target: 'e2' });
  assert.equal(ledger.getAccount('a').state, 'OPEN');

  assert.throws(
    () => ledger.undoPlan('e1'),
    (err) => err.code === 'ILLEGAL_TRANSITION',
  );
});

test('undo of void restores the auto-released holds', () => {
  const ledger = openWith(80);
  ledger.apply({ id: 'e2', op: 'hold', account: 'a', amount: 30 });
  ledger.apply({ id: 'e3', op: 'void', account: 'a' });
  assert.deepEqual(ledger.getAccount('a'), { state: 'VOIDED', balance: 80, held: 0 });
  ledger.apply({ id: 'u1', op: 'undo', account: 'a', target: 'e3' });
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 80, held: 30 });
});
