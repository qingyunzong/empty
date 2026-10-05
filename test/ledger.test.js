'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../src/ledger');
const { ProtocolError, BudgetError } = require('../src/errors');

test('occupy/release within a confirmed transaction', () => {
  const l = new Ledger(100);
  l.begin();
  l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 30 });
  l.occupy({ op: 'PLAN', id: 'B', ver: 1, cost: 20 });
  l.commit();
  assert.equal(l.used, 50);
  assert.equal(l.entries.length, 2);
  assert.deepEqual(
    l.entries.map((e) => [e.op, e.id, e.delta, e.used]),
    [['PLAN', 'A', 30, 30], ['PLAN', 'B', 20, 50]]
  );
  l.begin();
  l.release('A', { op: 'CANCEL', ver: 2 });
  l.commit();
  assert.equal(l.used, 20);
  assert.equal(l.jobs.has('A'), false);
});

test('budget cap enforced inside transaction', () => {
  const l = new Ledger(10);
  l.begin();
  assert.throws(() => l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 11 }), BudgetError);
  l.rollback();
  assert.equal(l.used, 0);
});

// Acceptance 3: nested unconfirmed transactions roll back by hierarchy level.
test('nested pending transactions roll back level by level', () => {
  const l = new Ledger(100);

  l.begin(); // L1
  l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });

  l.begin(); // L2
  l.occupy({ op: 'PLAN', id: 'B', ver: 1, cost: 20 });
  l.rollback(); // undo L2 only
  assert.equal(l.used, 10);
  assert.equal(l.jobs.has('A'), true);
  assert.equal(l.jobs.has('B'), false);

  l.begin(); // L2 again
  l.occupy({ op: 'PLAN', id: 'C', ver: 1, cost: 5 });
  l.commit(); // merge L2 into L1 (still unconfirmed)
  assert.equal(l.used, 15);
  assert.equal(l.entries.length, 0);

  l.rollback(); // undo L1: both A and C vanish
  assert.equal(l.used, 0);
  assert.equal(l.jobs.size, 0);
  assert.equal(l.entries.length, 0);
});

test('inner commit then outer confirm appends flows in order', () => {
  const l = new Ledger(100);
  l.begin();
  l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 10 });
  l.begin();
  l.occupy({ op: 'PLAN', id: 'B', ver: 1, cost: 20 });
  l.commit();
  l.commit();
  assert.equal(l.used, 30);
  assert.deepEqual(l.entries.map((e) => [e.id, e.delta, e.used]), [
    ['A', 10, 10],
    ['B', 20, 30],
  ]);
});

// Acceptance 3 (boundary): rollback may never touch ACKed history.
test('rollback of confirmed history is forbidden', () => {
  const l = new Ledger(100);
  l.begin();
  l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 40 });
  l.commit(); // confirmed (ACKed)

  assert.throws(() => l.rollback(), ProtocolError);
  assert.equal(l.used, 40);
  assert.equal(l.jobs.has('A'), true);

  // A later unconfirmed transaction rolls back without touching history.
  l.begin();
  l.occupy({ op: 'PLAN', id: 'B', ver: 1, cost: 10 });
  l.rollback();
  assert.equal(l.used, 40);
  assert.equal(l.jobs.has('A'), true);
  assert.equal(l.jobs.has('B'), false);
  assert.equal(l.entries.length, 1);
});

test('mutation outside a transaction is rejected', () => {
  const l = new Ledger(100);
  assert.throws(() => l.occupy({ op: 'PLAN', id: 'A', ver: 1, cost: 1 }), ProtocolError);
  assert.throws(() => l.commit(), ProtocolError);
});
