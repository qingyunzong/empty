'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

test('C: three-level batch, level-2 failure rolls back locally, parent continues', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e0', op: 'open', account: 'a', balance: 100 });

  ledger.beginBatch('L1', { onChildFailure: 'continue' });
  ledger.apply({ id: 'e1', op: 'credit', account: 'a', amount: 10 }); // 110

  ledger.beginBatch('L2');
  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 }); // 80

  ledger.beginBatch('L3');
  ledger.apply({ id: 'e3', op: 'credit', account: 'a', amount: 5 }); // 85
  const r3 = ledger.endBatch(); // L3 ok -> merges into L2
  assert.equal(r3.rolledBack, false);

  assert.throws(
    () => ledger.apply({ id: 'e4', op: 'debit', account: 'a', amount: 200 }),
    (err) => err.code === 'NEGATIVE',
  ); // L2 is now failed

  const r2 = ledger.endBatch(); // L2 rolls back only its own subtree
  assert.equal(r2.rolledBack, true);
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 110, held: 0 });
  assert.equal(ledger.events.has('e2'), false, 'rolled-back events leave history');
  assert.equal(ledger.events.has('e3'), false);
  assert.equal(ledger.head, 'e1');

  ledger.apply({ id: 'e5', op: 'credit', account: 'a', amount: 7 }); // parent continues: 117
  const r1 = ledger.endBatch();
  assert.equal(r1.rolledBack, false);
  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 117, held: 0 });
  assert.equal(ledger.head, 'e5');
});

test('C: parent policy abort cascades the rollback to the whole tree', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e0', op: 'open', account: 'a', balance: 100 });

  ledger.beginBatch('L1', { onChildFailure: 'abort' });
  ledger.apply({ id: 'e1', op: 'credit', account: 'a', amount: 10 }); // 110
  ledger.beginBatch('L2');
  ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 }); // 80
  assert.throws(
    () => ledger.apply({ id: 'e3', op: 'debit', account: 'a', amount: 500 }),
    (err) => err.code === 'NEGATIVE',
  );
  assert.equal(ledger.endBatch().rolledBack, true); // L2 local rollback
  assert.equal(ledger.endBatch().rolledBack, true); // L1 aborts entirely

  assert.deepEqual(ledger.getAccount('a'), { state: 'OPEN', balance: 100, held: 0 });
  assert.equal(ledger.head, 'e0');
  assert.equal(ledger.events.has('e1'), false);
});

test('C: batch rollback is deterministic across repeated runs', () => {
  const run = () => {
    const ledger = new Ledger();
    ledger.apply({ id: 'e0', op: 'open', account: 'a', balance: 100 });
    ledger.beginBatch('L1', { onChildFailure: 'continue' });
    ledger.apply({ id: 'e1', op: 'credit', account: 'a', amount: 10 });
    ledger.beginBatch('L2');
    ledger.apply({ id: 'e2', op: 'debit', account: 'a', amount: 30 });
    ledger.beginBatch('L3');
    ledger.apply({ id: 'e3', op: 'credit', account: 'a', amount: 5 });
    ledger.endBatch();
    assert.throws(() => ledger.apply({ id: 'e4', op: 'debit', account: 'a', amount: 200 }));
    ledger.endBatch();
    ledger.apply({ id: 'e5', op: 'credit', account: 'a', amount: 7 });
    ledger.endBatch();
    return ledger.getState();
  };
  assert.deepEqual(run(), run());
});
