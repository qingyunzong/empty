'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { TERMINAL } = require('../src/state-machine');

const DAY = '2026-10-01';

function authTxn(ledger, id, over = {}) {
  ledger.apply({ type: 'auth', id, merchant: 'm1', day: DAY, amount: 100, currency: 'USD', tip: 5, ...over });
  return id;
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.code === code);
}

test('A: legal full-path transitions', () => {
  const l = new Ledger();
  // auth -> capture -> refund -> reverse -> capture -> chargeback -> reverse_chargeback -> capture
  authTxn(l, 't1');
  assert.equal(l.txns.get('t1').state, 'auth');
  l.apply({ type: 'capture', id: 't1' });
  assert.equal(l.txns.get('t1').state, 'captured');
  l.apply({ type: 'refund', id: 't1' });
  assert.equal(l.txns.get('t1').state, 'refunded');
  l.apply({ type: 'reverse', id: 't1' });
  assert.equal(l.txns.get('t1').state, 'captured');
  l.apply({ type: 'chargeback', id: 't1' });
  assert.equal(l.txns.get('t1').state, 'charged_back');
  l.apply({ type: 'reverse_chargeback', id: 't1' });
  assert.equal(l.txns.get('t1').state, 'captured');
  // auth -> void
  authTxn(l, 't2');
  l.apply({ type: 'void', id: 't2' });
  assert.equal(l.txns.get('t2').state, 'voided');
  assert.ok(TERMINAL.has('voided'));
});

test('A: illegal transitions raise E_TRANSITION', () => {
  const l = new Ledger();
  authTxn(l, 'a');
  // from auth
  expectCode(() => l.apply({ type: 'refund', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'chargeback', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'reverse', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'reverse_chargeback', id: 'a' }), 'E_TRANSITION');
  // from captured
  l.apply({ type: 'capture', id: 'a' });
  expectCode(() => l.apply({ type: 'void', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'capture', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'reverse', id: 'a' }), 'E_TRANSITION');
  // refund reversed at most once
  l.apply({ type: 'refund', id: 'a' });
  expectCode(() => l.apply({ type: 'refund', id: 'a' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'chargeback', id: 'a' }), 'E_TRANSITION');
  l.apply({ type: 'reverse', id: 'a' });
  l.apply({ type: 'refund', id: 'a' });
  expectCode(() => l.apply({ type: 'reverse', id: 'a' }), 'E_TRANSITION');
  // chargeback: only reverse_chargeback allowed
  authTxn(l, 'b');
  l.apply({ type: 'capture', id: 'b' });
  l.apply({ type: 'chargeback', id: 'b' });
  expectCode(() => l.apply({ type: 'refund', id: 'b' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'reverse', id: 'b' }), 'E_TRANSITION');
  expectCode(() => l.apply({ type: 'capture', id: 'b' }), 'E_TRANSITION');
});

test('A: terminal state is immutable', () => {
  const l = new Ledger();
  authTxn(l, 'v');
  l.apply({ type: 'void', id: 'v' });
  for (const op of ['capture', 'void', 'refund', 'reverse', 'chargeback', 'reverse_chargeback']) {
    expectCode(() => l.apply({ type: op, id: 'v' }), 'E_TRANSITION');
    assert.equal(l.txns.get('v').state, 'voided');
  }
});

test('A: unknown id and duplicate auth', () => {
  const l = new Ledger();
  expectCode(() => l.apply({ type: 'capture', id: 'nope' }), 'E_NOT_FOUND');
  authTxn(l, 'dup');
  expectCode(() => authTxn(l, 'dup'), 'E_VALIDATION');
  expectCode(() => l.apply({ type: 'auth', id: 'x', merchant: 'm', day: DAY, amount: 'lots' }), 'E_VALIDATION');
  expectCode(() => l.apply({ type: 'frob', id: 'x' }), 'E_VALIDATION');
});
