'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { ERR } = require('../src/core');

test('F: undo on a side branch yields FORK_CONFLICT with witness path', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 100 });
  ledger.apply({ id: 'e2', type: 'debit', account: 'a', amount: 10, parent: 'e1' });
  // concurrent branch: e3 also points at e1 while head is e2
  ledger.apply({ id: 'e3', type: 'credit', account: 'a', amount: 5, parent: 'e1' });
  assert.equal(ledger.summary().a.balance, 95);

  const res = ledger.apply({ id: 'u1', type: 'undo', account: 'a', target: 'e2' });
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.FORK_CONFLICT);
  assert.deepEqual(res.witness, {
    forkPoint: 'e1',
    headPath: ['e3', 'e1'],
    branchPath: ['e2'],
  });
  // no silent state change
  assert.equal(ledger.summary().a.balance, 95);
  assert.deepEqual([...ledger.accounts.get('a').undone], []);

  // undo of an event on the head path succeeds
  const ok = ledger.apply({ id: 'u2', type: 'undo', account: 'a', target: 'e3' });
  assert.equal(ok.ok, true);
  assert.equal(ledger.summary().a.balance, 90);
});

test('F: undo rejects unknown, repeated and non-undoable targets', () => {
  const ledger = new Ledger();
  ledger.apply({ id: 'e1', type: 'open', account: 'a', amount: 50 });
  ledger.apply({ id: 'e2', type: 'debit', account: 'a', amount: 10 });

  const unknown = ledger.apply({ id: 'u1', type: 'undo', account: 'a', target: 'nope' });
  assert.equal(unknown.code, ERR.ILLEGAL_TRANSITION);

  const notUndoable = ledger.apply({ id: 'u2', type: 'undo', account: 'a', target: 'e1' });
  assert.equal(notUndoable.code, ERR.ILLEGAL_TRANSITION);

  assert.equal(ledger.apply({ id: 'u3', type: 'undo', account: 'a', target: 'e2' }).ok, true);
  const twice = ledger.apply({ id: 'u4', type: 'undo', account: 'a', target: 'e2' });
  assert.equal(twice.code, ERR.ILLEGAL_TRANSITION);
  assert.equal(ledger.summary().a.balance, 50);
});
