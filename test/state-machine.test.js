import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { E } from '../src/errors.js';
import { TRANSITIONS } from '../src/stateMachine.js';

let seq = 0;

// Build a ledger containing one transaction driven into the target state.
function txInState(state) {
  const ledger = new Ledger();
  const id = `t${++seq}`;
  ledger.apply({ type: 'auth', id, merchant: 'm', day: '2024-01-01', amount: 100, currency: 'USD' });
  if (state === 'auth') return { ledger, id };
  if (state === 'void') {
    ledger.apply({ type: 'void', id });
    return { ledger, id };
  }
  ledger.apply({ type: 'capture', id, day: '2024-01-02' });
  if (state === 'capture') return { ledger, id };
  if (state === 'refund') {
    ledger.apply({ type: 'refund', id });
    return { ledger, id };
  }
  if (state === 'chargeback') {
    ledger.apply({ type: 'chargeback', id });
    return { ledger, id };
  }
  throw new Error(`bad state ${state}`);
}

const TX_EVENTS = ['capture', 'void', 'refund', 'chargeback', 'reverse_refund', 'reverse_chargeback'];

test('A: every legal transition succeeds and lands in the expected state', () => {
  for (const [from, edges] of Object.entries(TRANSITIONS)) {
    for (const [eventType, expected] of Object.entries(edges)) {
      const { ledger, id } = txInState(from);
      ledger.apply({ type: eventType, id, day: '2024-01-03' });
      assert.equal(ledger.transactions.get(id).state, expected, `${from} --${eventType}--> ${expected}`);
    }
  }
});

test('A: every illegal transition from every state fails with E_TRANSITION', () => {
  for (const state of Object.keys(TRANSITIONS)) {
    const allowed = new Set(Object.keys(TRANSITIONS[state]));
    for (const eventType of TX_EVENTS) {
      if (allowed.has(eventType)) continue;
      const { ledger, id } = txInState(state);
      assert.throws(
        () => ledger.apply({ type: eventType, id, day: '2024-01-03' }),
        (err) => err.code === E.TRANSITION,
        `${eventType} on state ${state} must throw E_TRANSITION`,
      );
      // no side effect: state unchanged
      assert.equal(ledger.transactions.get(id).state, state);
    }
  }
});

test('A: terminal state void is immutable for all event types', () => {
  for (const eventType of TX_EVENTS) {
    const { ledger, id } = txInState('void');
    assert.throws(
      () => ledger.apply({ type: eventType, id }),
      (err) => err.code === E.TRANSITION,
    );
    assert.equal(ledger.transactions.get(id).state, 'void');
  }
});

test('A: refund can be reversed exactly once', () => {
  const { ledger, id } = txInState('refund');
  ledger.apply({ type: 'reverse_refund', id });
  assert.equal(ledger.transactions.get(id).state, 'capture');
  // re-refund is legal from capture, but a second reversal is not
  ledger.apply({ type: 'refund', id });
  assert.throws(
    () => ledger.apply({ type: 'reverse_refund', id }),
    (err) => err.code === E.TRANSITION,
  );
  assert.equal(ledger.transactions.get(id).state, 'refund');
});

test('A: unknown id gives E_NOT_FOUND, duplicate auth gives E_DUPLICATE', () => {
  const ledger = new Ledger();
  assert.throws(
    () => ledger.apply({ type: 'capture', id: 'nope', day: '2024-01-01' }),
    (err) => err.code === E.NOT_FOUND,
  );
  ledger.apply({ type: 'auth', id: 'x', merchant: 'm', day: '2024-01-01' });
  assert.throws(
    () => ledger.apply({ type: 'auth', id: 'x', merchant: 'm', day: '2024-01-01' }),
    (err) => err.code === E.DUPLICATE,
  );
});

test('A: malformed events give E_VALIDATION', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.apply(null), (err) => err.code === E.VALIDATION);
  assert.throws(() => ledger.apply({}), (err) => err.code === E.VALIDATION);
  assert.throws(
    () => ledger.apply({ type: 'auth', id: 'a', merchant: 'm', day: '01-01' }),
    (err) => err.code === E.VALIDATION,
  );
  assert.throws(
    () => ledger.apply({ type: 'auth', id: 'b', merchant: 'm', day: '2024-01-01', amount: -5 }),
    (err) => err.code === E.VALIDATION,
  );
  assert.throws(
    () => ledger.apply({ type: 'explode', id: 'c' }),
    (err) => err.code === E.VALIDATION,
  );
});
