import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function freshLedger() {
  return new Ledger([100, 50], []);
}

test('reserve holds limit without touching balance', () => {
  const ledger = freshLedger();
  const outcome = ledger.apply({ type: 'reserve', account: 0, amount: 30, reservationId: 'res-0' });
  assert.equal(outcome.result, 'applied');
  const state = ledger.snapshot();
  assert.equal(state.accounts[0].balance, 100);
  assert.equal(state.accounts[0].held, 30);
  assert.equal(state.reservations['res-0'].status, 'open');
});

test('settle deducts held and balance', () => {
  const ledger = freshLedger();
  ledger.apply({ type: 'reserve', account: 0, amount: 30, reservationId: 'res-0' });
  const outcome = ledger.apply({ type: 'settle', reservationId: 'res-0' });
  assert.equal(outcome.result, 'applied');
  const state = ledger.snapshot();
  assert.equal(state.accounts[0].balance, 70);
  assert.equal(state.accounts[0].held, 0);
  assert.equal(state.reservations['res-0'].status, 'settled');
});

test('cancel before settle restores limit', () => {
  const ledger = freshLedger();
  ledger.apply({ type: 'reserve', account: 0, amount: 30, reservationId: 'res-0' });
  const outcome = ledger.apply({ type: 'cancel', reservationId: 'res-0' });
  assert.equal(outcome.result, 'applied');
  const state = ledger.snapshot();
  assert.equal(state.accounts[0].balance, 100);
  assert.equal(state.accounts[0].held, 0);
  assert.equal(state.reservations['res-0'].status, 'cancelled');
});

test('cancel after settle is rejected as a race and changes nothing', () => {
  const ledger = freshLedger();
  ledger.apply({ type: 'reserve', account: 0, amount: 30, reservationId: 'res-0' });
  ledger.apply({ type: 'settle', reservationId: 'res-0' });
  const before = ledger.snapshot();
  const outcome = ledger.apply({ type: 'cancel', reservationId: 'res-0' });
  assert.equal(outcome.result, 'rejected');
  assert.equal(outcome.reason, 'RACE_ALREADY_SETTLED');
  assert.deepEqual(ledger.snapshot(), before);
});

test('settle after cancel is rejected as a race and changes nothing', () => {
  const ledger = freshLedger();
  ledger.apply({ type: 'reserve', account: 0, amount: 30, reservationId: 'res-0' });
  ledger.apply({ type: 'cancel', reservationId: 'res-0' });
  const before = ledger.snapshot();
  const outcome = ledger.apply({ type: 'settle', reservationId: 'res-0' });
  assert.equal(outcome.result, 'rejected');
  assert.match(outcome.reason, /^RACE_NOT_OPEN:cancelled$/);
  assert.deepEqual(ledger.snapshot(), before);
});

test('insufficient funds rejects without partial mutation', () => {
  const ledger = freshLedger();
  ledger.apply({ type: 'reserve', account: 0, amount: 80, reservationId: 'res-0' });
  const before = ledger.snapshot();
  const outcome = ledger.apply({ type: 'reserve', account: 0, amount: 21, reservationId: 'res-1' });
  assert.equal(outcome.result, 'rejected');
  assert.equal(outcome.reason, 'INSUFFICIENT_FUNDS');
  assert.deepEqual(ledger.snapshot(), before);
});

test('frozen account rejects reserve without partial mutation', () => {
  const ledger = new Ledger([100, 50], [1]);
  const before = ledger.snapshot();
  const outcome = ledger.apply({ type: 'reserve', account: 1, amount: 10, reservationId: 'res-0' });
  assert.equal(outcome.result, 'rejected');
  assert.equal(outcome.reason, 'ACCOUNT_FROZEN');
  assert.deepEqual(ledger.snapshot(), before);
});

test('unknown reservation and unknown op type', () => {
  const ledger = freshLedger();
  assert.equal(ledger.apply({ type: 'settle', reservationId: 'nope' }).reason, 'UNKNOWN_RESERVATION');
  assert.throws(() => ledger.apply({ type: 'explode' }), { code: 'INVALID_INPUT' });
});
