import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const fresh = () =>
  new Ledger([
    { id: 'A0', balance: 100 },
    { id: 'A1', balance: 50, frozen: true },
  ]);

test('reserve holds available limit', () => {
  const l = fresh();
  const r = l.apply({ type: 'reserve', account: 'A0', amount: 40 });
  assert.deepEqual(r, { status: 'ok', holdId: 'H0' });
  const acc = l.snapshot().accounts[0];
  assert.equal(acc.held, 40);
  assert.equal(acc.balance, 100);
});

test('settle debits held and balance', () => {
  const l = fresh();
  l.apply({ type: 'reserve', account: 'A0', amount: 40 });
  const r = l.apply({ type: 'settle', holdId: 'H0' });
  assert.deepEqual(r, { status: 'ok', holdId: 'H0', amount: 40 });
  const s = l.snapshot();
  assert.equal(s.accounts[0].held, 0);
  assert.equal(s.accounts[0].balance, 60);
  assert.equal(s.holds[0].state, 'settled');
});

test('cancel before settle restores limit', () => {
  const l = fresh();
  l.apply({ type: 'reserve', account: 'A0', amount: 40 });
  const r = l.apply({ type: 'cancel', holdId: 'H0' });
  assert.equal(r.status, 'ok');
  const s = l.snapshot();
  assert.equal(s.accounts[0].held, 0);
  assert.equal(s.accounts[0].balance, 100);
  assert.equal(s.holds[0].state, 'cancelled');
});

test('cancel after settle is rejected (race) and changes nothing', () => {
  const l = fresh();
  l.apply({ type: 'reserve', account: 'A0', amount: 40 });
  l.apply({ type: 'settle', holdId: 'H0' });
  const before = l.snapshot();
  const r = l.apply({ type: 'cancel', holdId: 'H0' });
  assert.deepEqual(r, { status: 'rejected', reason: 'hold_not_open' });
  assert.deepEqual(l.snapshot(), before);
});

test('settle after cancel is rejected (race) and changes nothing', () => {
  const l = fresh();
  l.apply({ type: 'reserve', account: 'A0', amount: 40 });
  l.apply({ type: 'cancel', holdId: 'H0' });
  const before = l.snapshot();
  const r = l.apply({ type: 'settle', holdId: 'H0' });
  assert.deepEqual(r, { status: 'rejected', reason: 'hold_not_open' });
  assert.deepEqual(l.snapshot(), before);
});

test('insufficient funds rejects without partial mutation', () => {
  const l = fresh();
  l.apply({ type: 'reserve', account: 'A0', amount: 80 });
  const before = l.snapshot();
  const r = l.apply({ type: 'reserve', account: 'A0', amount: 30 });
  assert.deepEqual(r, { status: 'rejected', reason: 'insufficient_funds' });
  assert.deepEqual(l.snapshot(), before);
});

test('frozen account rejects reserve/settle/cancel without mutation', () => {
  const l = new Ledger([{ id: 'A0', balance: 100 }]);
  l.apply({ type: 'reserve', account: 'A0', amount: 10 });
  l.accounts[0].frozen = true;
  const before = l.snapshot();
  assert.equal(l.apply({ type: 'reserve', account: 'A0', amount: 1 }).reason, 'account_frozen');
  assert.equal(l.apply({ type: 'settle', holdId: 'H0' }).reason, 'account_frozen');
  assert.equal(l.apply({ type: 'cancel', holdId: 'H0' }).reason, 'account_frozen');
  assert.deepEqual(l.snapshot(), before);
});

test('unknown hold rejects without mutation', () => {
  const l = fresh();
  const before = l.snapshot();
  assert.equal(l.apply({ type: 'settle', holdId: 'H99' }).reason, 'hold_not_found');
  assert.equal(l.apply({ type: 'cancel', holdId: 'H99' }).reason, 'hold_not_found');
  assert.deepEqual(l.snapshot(), before);
});

test('unknown op type throws INVALID_INPUT', () => {
  const l = fresh();
  assert.throws(() => l.apply({ type: 'refund' }), /INVALID_INPUT|unknown op type/);
  try {
    l.apply({ type: 'refund' });
  } catch (e) {
    assert.equal(e.code, 'INVALID_INPUT');
  }
});

test('malformed ops throw INVALID_INPUT', () => {
  const l = fresh();
  for (const op of [
    { type: 'reserve', account: 'A0', amount: -5 },
    { type: 'reserve', account: 'A0', amount: 0 },
    { type: 'reserve', account: 'A0' },
    { type: 'settle' },
    { type: 'reserve', account: 'NOPE', amount: 1 },
  ]) {
    assert.throws(() => l.apply(op), (e) => e.code === 'INVALID_INPUT');
  }
});
