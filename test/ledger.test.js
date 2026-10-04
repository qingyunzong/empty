import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  applySubmit,
  applyCancel,
  applySettle,
  stateHash,
  LedgerError,
  STATUS,
} from '../src/ledger.js';

const entry = (id, amount = 100) => ({
  entryId: id,
  payer: 'alice',
  payee: 'bob',
  amount,
});

test('submit stores a pending entry', () => {
  const state = createState();
  const r = applySubmit(state, entry('e1'));
  assert.equal(r.changed, true);
  assert.equal(state.entries.e1.status, STATUS.PENDING);
});

test('duplicate entryId submit is idempotent and does not change state', () => {
  const state = createState();
  applySubmit(state, entry('e1', 100));
  const before = stateHash(state);
  const r1 = applySubmit(state, entry('e1', 100));
  const r2 = applySubmit(state, entry('e1', 999)); // conflicting payload still ignored
  assert.equal(r1.duplicate, true);
  assert.equal(r2.duplicate, true);
  assert.equal(state.entries.e1.amount, 100);
  assert.equal(stateHash(state), before);
});

test('cancel moves a pending entry to cancelled', () => {
  const state = createState();
  applySubmit(state, entry('e1'));
  applyCancel(state, { entryId: 'e1' });
  assert.equal(state.entries.e1.status, STATUS.CANCELLED);
});

test('cancel of settled entry is rejected with ENTRY_NOT_PENDING and does not change state', () => {
  const state = createState();
  applySubmit(state, entry('e1'));
  applySettle(state);
  const before = stateHash(state);
  assert.throws(() => applyCancel(state, { entryId: 'e1' }), (err) => {
    assert.equal(err.code, 'ENTRY_NOT_PENDING');
    return true;
  });
  assert.equal(stateHash(state), before);
});

test('cancel of cancelled entry is rejected with ENTRY_NOT_PENDING', () => {
  const state = createState();
  applySubmit(state, entry('e1'));
  applyCancel(state, { entryId: 'e1' });
  assert.throws(
    () => applyCancel(state, { entryId: 'e1' }),
    (err) => err.code === 'ENTRY_NOT_PENDING',
  );
});

test('cancel of unknown entry is rejected with ENTRY_NOT_FOUND', () => {
  const state = createState();
  assert.throws(
    () => applyCancel(state, { entryId: 'nope' }),
    (err) => err.code === 'ENTRY_NOT_FOUND',
  );
});

test('settle computes bilateral nets and settles all pending entries atomically', () => {
  const state = createState();
  applySubmit(state, { entryId: 'e1', payer: 'a', payee: 'b', amount: 100 });
  applySubmit(state, { entryId: 'e2', payer: 'b', payee: 'c', amount: 40 });
  applySubmit(state, { entryId: 'e3', payer: 'c', payee: 'a', amount: 25 });
  applySubmit(state, { entryId: 'e4', payer: 'a', payee: 'b', amount: 10 });
  applyCancel(state, { entryId: 'e4' });
  const { settlement } = applySettle(state);
  assert.deepEqual(settlement.nets, { a: -75, b: 60, c: 15 });
  assert.deepEqual(settlement.entryIds, ['e1', 'e2', 'e3']);
  assert.equal(state.entries.e1.status, STATUS.SETTLED);
  assert.equal(state.entries.e2.status, STATUS.SETTLED);
  assert.equal(state.entries.e3.status, STATUS.SETTLED);
  assert.equal(state.entries.e4.status, STATUS.CANCELLED);
  const sum = Object.values(settlement.nets).reduce((x, y) => x + y, 0);
  assert.equal(sum, 0);
});

test('settle with no pending entries is a no-op', () => {
  const state = createState();
  const r = applySettle(state);
  assert.equal(r.changed, false);
  assert.equal(state.settlements.length, 0);
});

test('invalid entries are rejected', () => {
  const state = createState();
  assert.throws(() => applySubmit(state, { entryId: '', payer: 'a', payee: 'b', amount: 1 }), LedgerError);
  assert.throws(() => applySubmit(state, { entryId: 'x', payer: 'a', payee: 'a', amount: 1 }), LedgerError);
  assert.throws(() => applySubmit(state, { entryId: 'x', payer: 'a', payee: 'b', amount: 0 }), LedgerError);
  assert.throws(() => applySubmit(state, { entryId: 'x', payer: 'a', payee: 'b', amount: 1.5 }), LedgerError);
  assert.throws(() => applySubmit(state, { entryId: 'x', payer: 'a', payee: 'b', amount: -3 }), LedgerError);
});
