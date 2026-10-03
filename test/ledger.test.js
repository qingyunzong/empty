'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LedgerError,
  createLedger,
  appendEvent,
  mergeLedgers,
  accountState,
  accountConflicts,
  allConflicts,
  accountHistory,
  isAncestor,
  areConcurrent,
} = require('../src/ledger');

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LedgerError);
    return error.code;
  }
  return null;
}

test('acceptance 1: zeroing transfer then remove succeeds, historical pay stays auditable', () => {
  const db = createLedger();
  appendEvent(db, { type: 'add-account', account: 'alice' });
  appendEvent(db, { type: 'add-account', account: 'bob' });
  const pay = appendEvent(db, { type: 'pay', account: 'alice', amount: 100 });
  appendEvent(db, { type: 'transfer', from: 'alice', to: 'bob', amount: 100 });
  const remove = appendEvent(db, { type: 'remove-account', account: 'alice' });

  const state = accountState(db, 'alice');
  assert.equal(state.status, 'removed');
  assert.equal(state.balance, 0);
  assert.equal(remove.epoch, 1);
  assert.equal(state.tombstone.id, remove.id);

  const history = accountHistory(db, 'alice');
  assert.ok(history.some((e) => e.id === pay.id && e.type === 'pay' && e.amount === 100));
  assert.ok(isAncestor(db, pay.id, remove.id), 'pay causally precedes removal');
  assert.equal(accountState(db, 'bob').balance, 100);
});

test('acceptance 2: remove with non-zero balance is rejected with balance-not-zero', () => {
  const db = createLedger();
  appendEvent(db, { type: 'add-account', account: 'alice' });
  appendEvent(db, { type: 'pay', account: 'alice', amount: 50 });
  assert.equal(
    codeOf(() => appendEvent(db, { type: 'remove-account', account: 'alice' })),
    'balance-not-zero'
  );
  assert.equal(accountState(db, 'alice').status, 'active');
});

test('acceptance 3: pay after remove rejected; re-added account starts from zero with new incarnation', () => {
  const db = createLedger();
  const add1 = appendEvent(db, { type: 'add-account', account: 'alice' });
  appendEvent(db, { type: 'add-account', account: 'bob' });
  appendEvent(db, { type: 'pay', account: 'alice', amount: 70 });
  appendEvent(db, { type: 'transfer', from: 'alice', to: 'bob', amount: 70 });
  appendEvent(db, { type: 'remove-account', account: 'alice' });

  assert.equal(
    codeOf(() => appendEvent(db, { type: 'pay', account: 'alice', amount: 5 })),
    'account-removed'
  );

  const add2 = appendEvent(db, { type: 'add-account', account: 'alice' });
  assert.notEqual(add2.incarnation, add1.incarnation);
  assert.equal(add2.epoch, 2);
  const state = accountState(db, 'alice');
  assert.equal(state.status, 'active');
  assert.equal(state.balance, 0, 'no balance inherited across the tombstone');
});

test('concurrent remove and pay are reported as a conflict', () => {
  const base = createLedger();
  appendEvent(base, { type: 'add-account', account: 'alice' });
  appendEvent(base, { type: 'add-account', account: 'bob' });
  appendEvent(base, { type: 'pay', account: 'alice', amount: 10 });
  appendEvent(base, { type: 'transfer', from: 'alice', to: 'bob', amount: 10 });

  const forkA = { events: base.events.map((e) => ({ ...e, deps: [...e.deps] })) };
  const forkB = { events: base.events.map((e) => ({ ...e, deps: [...e.deps] })) };
  const pay = appendEvent(forkA, { type: 'pay', account: 'alice', amount: 5 });
  const remove = appendEvent(forkB, { type: 'remove-account', account: 'alice' });
  assert.ok(areConcurrent(forkA, pay.id, remove.id) || areConcurrent(
    { events: [...forkA.events, ...forkB.events.filter((e) => e.id === remove.id)] },
    pay.id,
    remove.id
  ));

  mergeLedgers(forkA, forkB);
  const conflicts = accountConflicts(forkA, 'alice');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'remove-pay');
  assert.equal(conflicts[0].remove, remove.id);
  assert.equal(conflicts[0].event, pay.id);
  assert.deepEqual(allConflicts(forkA), conflicts);
});

test('tombstone epochs and incarnation ids form a strict chain across re-adds', () => {
  const db = createLedger();
  appendEvent(db, { type: 'add-account', account: 'bob' });
  const adds = [];
  const tombstones = [];
  for (let round = 0; round < 3; round += 1) {
    adds.push(appendEvent(db, { type: 'add-account', account: 'alice' }));
    appendEvent(db, { type: 'pay', account: 'alice', amount: 20 });
    appendEvent(db, { type: 'transfer', from: 'alice', to: 'bob', amount: 20 });
    tombstones.push(appendEvent(db, { type: 'remove-account', account: 'alice' }));
  }
  assert.deepEqual(adds.map((e) => e.epoch), [1, 2, 3]);
  assert.deepEqual(tombstones.map((e) => e.epoch), [1, 2, 3]);
  assert.equal(new Set(adds.map((e) => e.incarnation)).size, 3);
  for (let i = 1; i < 3; i += 1) {
    assert.ok(isAncestor(db, tombstones[i - 1].id, adds[i].id));
  }
  assert.equal(accountState(db, 'alice').status, 'removed');
  assert.equal(accountState(db, 'bob').balance, 60);
});

// Enumeration: two accounts (alice pre-added, bob pre-added), three events
// P = pay alice 40, T = transfer alice->bob 40, R = remove alice.
// Every permutation is replayed against the library and checked against an
// independent reference model of balances and the epoch table.
const EVENTS = {
  P: { type: 'pay', account: 'alice', amount: 40 },
  T: { type: 'transfer', from: 'alice', to: 'bob', amount: 40 },
  R: { type: 'remove-account', account: 'alice' },
};

function permutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([items[i], ...tail]);
  }
  return result;
}

// Independent reference: plain sequential simulation, no causal machinery.
function referenceRun(order) {
  const balances = { alice: 0, bob: 0 };
  let removed = false;
  let epoch = 1;
  const errors = [];
  for (const step of order) {
    if (step === 'P') {
      if (removed) errors.push('account-removed');
      else balances.alice += 40;
    } else if (step === 'T') {
      if (removed) errors.push('account-removed');
      else {
        balances.alice -= 40;
        balances.bob += 40;
      }
    } else if (step === 'R') {
      if (balances.alice !== 0) errors.push('balance-not-zero');
      else removed = true;
    }
  }
  return { balances, removed, epoch, errors };
}

test('enumeration: all orderings of pay/transfer/remove across two accounts match reference', () => {
  const orders = permutations(['P', 'T', 'R']);
  assert.equal(orders.length, 6);
  for (const order of orders) {
    const db = createLedger();
    appendEvent(db, { type: 'add-account', account: 'alice' });
    appendEvent(db, { type: 'add-account', account: 'bob' });
    const errors = [];
    for (const step of order) {
      const code = codeOf(() => appendEvent(db, { ...EVENTS[step] }));
      if (code) errors.push(code);
    }
    const reference = referenceRun(order);
    const alice = accountState(db, 'alice');
    const bob = accountState(db, 'bob');
    assert.equal(alice.balance, reference.balances.alice, `alice balance for ${order}`);
    assert.equal(bob.balance, reference.balances.bob, `bob balance for ${order}`);
    assert.equal(alice.status, reference.removed ? 'removed' : 'active', `alice status for ${order}`);
    assert.equal(alice.epoch, reference.epoch, `alice epoch for ${order}`);
    assert.deepEqual(errors, reference.errors, `errors for ${order}`);
  }
});
