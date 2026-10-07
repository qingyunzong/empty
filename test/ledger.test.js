import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountState,
  addAccount,
  areConcurrent,
  createLedger,
  happensBefore,
  mergeLedgers,
  pay,
  removeAccount,
  transfer,
} from '../src/ledger.js';

function expectCode(code, fn) {
  assert.throws(fn, (err) => err.code === code);
}

test('acceptance 1: zeroing transfer then remove succeeds, historical pay stays auditable', () => {
  const ledger = createLedger('acc1');
  addAccount(ledger, 'alice');
  addAccount(ledger, 'bob');
  pay(ledger, 'alice', 100);
  transfer(ledger, 'alice', 'bob', 100);
  const tomb = removeAccount(ledger, 'alice');

  assert.equal(tomb.type, 'remove-account');
  assert.equal(tomb.epoch, 1);

  const alice = accountState(ledger, 'alice');
  assert.equal(alice.status, 'removed');
  assert.equal(alice.balance, 0);
  assert.equal(alice.epoch, 1);

  const pays = alice.history.filter((e) => e.type === 'pay');
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount, 100);
  assert.ok(happensBefore(pays[0], tomb), 'historical pay causally precedes tombstone');

  assert.equal(accountState(ledger, 'bob').balance, 100);
});

test('acceptance 2: remove with non-zero balance is rejected with balance-not-zero', () => {
  const ledger = createLedger('acc2');
  addAccount(ledger, 'alice');
  pay(ledger, 'alice', 7);
  expectCode('balance-not-zero', () => removeAccount(ledger, 'alice'));
  assert.equal(accountState(ledger, 'alice').status, 'active');
});

test('acceptance 3: pay after removal rejected; re-added namesake starts at zero with new incarnation', () => {
  const ledger = createLedger('acc3');
  const first = addAccount(ledger, 'alice');
  addAccount(ledger, 'bob');
  pay(ledger, 'alice', 30);
  transfer(ledger, 'alice', 'bob', 30);
  removeAccount(ledger, 'alice');

  expectCode('account-removed', () => pay(ledger, 'alice', 5));
  expectCode('account-removed', () => transfer(ledger, 'alice', 'bob', 5));

  const second = addAccount(ledger, 'alice');
  assert.notEqual(second.incarnation, first.incarnation);
  assert.equal(second.epoch, 1);

  const state = accountState(ledger, 'alice');
  assert.equal(state.status, 'active');
  assert.equal(state.balance, 0);
  assert.equal(state.incarnation, 'alice#2');

  pay(ledger, 'alice', 12);
  assert.equal(accountState(ledger, 'alice').balance, 12);
});

test('enumeration: two accounts, three events, all orderings vs reference balance/epoch table', () => {
  // P = pay alice 50, T = transfer alice->bob 50, R = remove alice
  const permutations = [
    ['P', 'T', 'R'],
    ['P', 'R', 'T'],
    ['T', 'P', 'R'],
    ['T', 'R', 'P'],
    ['R', 'P', 'T'],
    ['R', 'T', 'P'],
  ];

  // Independent sequential reference model.
  function referenceRun(order) {
    let alice = 0;
    let bob = 0;
    let removed = false;
    let epoch = 0;
    const outcomes = [];
    for (const step of order) {
      if (step === 'P') {
        if (removed) outcomes.push('account-removed');
        else { alice += 50; outcomes.push('ok'); }
      } else if (step === 'T') {
        if (removed) outcomes.push('account-removed');
        else { alice -= 50; bob += 50; outcomes.push('ok'); }
      } else if (removed) outcomes.push('account-removed');
      else if (alice !== 0) outcomes.push('balance-not-zero');
      else { removed = true; epoch = 1; outcomes.push('ok'); }
    }
    return {
      outcomes,
      aliceBalance: alice,
      bobBalance: bob,
      aliceEpoch: epoch,
      aliceStatus: removed ? 'removed' : 'active',
    };
  }

  for (const order of permutations) {
    const label = order.join('');
    const ledger = createLedger(`enum-${label}`);
    addAccount(ledger, 'alice');
    addAccount(ledger, 'bob');

    const outcomes = [];
    for (const step of order) {
      try {
        if (step === 'P') pay(ledger, 'alice', 50);
        else if (step === 'T') transfer(ledger, 'alice', 'bob', 50);
        else removeAccount(ledger, 'alice');
        outcomes.push('ok');
      } catch (err) {
        outcomes.push(err.code);
      }
    }

    const ref = referenceRun(order);
    const alice = accountState(ledger, 'alice');
    const bob = accountState(ledger, 'bob');

    assert.deepEqual(outcomes, ref.outcomes, `outcomes for ${label}`);
    assert.equal(alice.balance, ref.aliceBalance, `alice balance for ${label}`);
    assert.equal(bob.balance, ref.bobBalance, `bob balance for ${label}`);
    assert.equal(alice.epoch, ref.aliceEpoch, `alice epoch for ${label}`);
    assert.equal(alice.status, ref.aliceStatus, `alice status for ${label}`);
  }
});

test('concurrent remove and pay are a conflict on merge', () => {
  const base = createLedger('base');
  addAccount(base, 'alice');

  const left = structuredClone(base);
  left.replica = 'left';
  const right = structuredClone(base);
  right.replica = 'right';

  const tomb = removeAccount(left, 'alice');
  const payment = pay(right, 'alice', 25);
  assert.ok(areConcurrent(tomb, payment));

  assert.throws(
    () => mergeLedgers(left, right),
    (err) => err.code === 'conflict' && err.details[0].name === 'alice',
  );
});

test('concurrent remove and transfer are a conflict on merge', () => {
  const base = createLedger('base');
  addAccount(base, 'alice');
  addAccount(base, 'bob');

  const left = structuredClone(base);
  left.replica = 'left';
  const right = structuredClone(base);
  right.replica = 'right';

  removeAccount(left, 'alice');
  pay(right, 'bob', 40);
  transfer(right, 'bob', 'alice', 40);

  assert.throws(() => mergeLedgers(left, right), (err) => err.code === 'conflict');
});

test('non-conflicting concurrent events merge and keep full balance', () => {
  const base = createLedger('base');
  addAccount(base, 'alice');

  const left = structuredClone(base);
  left.replica = 'left';
  const right = structuredClone(base);
  right.replica = 'right';

  pay(left, 'alice', 10);
  pay(right, 'alice', 5);

  const { ledger, added } = mergeLedgers(left, right);
  assert.equal(added, 1);
  assert.equal(accountState(ledger, 'alice').balance, 15);
});

test('pay causally before removal survives merge; pay causally after was already rejected', () => {
  const left = createLedger('left');
  addAccount(left, 'alice');
  addAccount(left, 'bob');
  pay(left, 'alice', 60);

  const right = structuredClone(left);
  right.replica = 'right';

  transfer(left, 'alice', 'bob', 60);
  removeAccount(left, 'alice');

  // right observed the pay and the tombstone; a pay now would be rejected.
  const mergedOnce = mergeLedgers(right, left).ledger;
  expectCode('account-removed', () => pay(mergedOnce, 'alice', 1));

  const alice = accountState(mergedOnce, 'alice');
  assert.equal(alice.status, 'removed');
  const historicalPay = alice.history.find((e) => e.type === 'pay');
  assert.equal(historicalPay.amount, 60);
});

test('duplicate events are idempotent under merge', () => {
  const left = createLedger('left');
  addAccount(left, 'alice');
  pay(left, 'alice', 3);
  const first = mergeLedgers(left, structuredClone(left));
  assert.equal(first.added, 0);
  const right = structuredClone(left);
  const second = mergeLedgers(left, right);
  assert.equal(second.added, 0);
  assert.equal(accountState(second.ledger, 'alice').balance, 3);
});
