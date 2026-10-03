import test from 'node:test';
import assert from 'node:assert/strict';
import { History, HistError } from '../src/history.js';
import { tmpdir } from '../support/helpers.js';

function setup() {
  const dir = tmpdir();
  const h = new History(dir);
  const put = h.put({ tradeId: 'T1', price: 100, quantity: 10, author: 'alice' });
  return { dir, h, base: put.hash };
}

test('linear put/replace materializes latest correction and recomputes margin', () => {
  const { h } = setup();
  h.replace({ tradeId: 'T1', price: 120, author: 'bob' });
  const m = h.materialize('T1');
  assert.deepEqual(m.state, { price: 120, quantity: 10, status: 'active' });
  assert.equal(m.margin.frozen, 120); // 120 * 10 * 0.1
  assert.equal(m.reference.deterministic, true);
});

test('concurrent disjoint field edits auto-merge', () => {
  const { h, base } = setup();
  h.replace({ tradeId: 'T1', price: 101, author: 'bob' });
  const r = h.replace({ tradeId: 'T1', base, quantity: 20, author: 'carol' });
  assert.equal(r.status, 'merged');
  assert.equal(h.heads('T1').length, 1);
  const m = h.materialize('T1');
  assert.deepEqual(m.state, { price: 101, quantity: 20, status: 'active' });
  assert.equal(m.reference.deterministic, true);
});

test('same-field conflict keeps concurrent heads and requires explicit resolve', () => {
  const { h, base } = setup();
  h.replace({ tradeId: 'T1', price: 101, author: 'bob' });
  assert.throws(
    () => h.replace({ tradeId: 'T1', base, price: 105, author: 'carol' }),
    (e) => e instanceof HistError && e.code === 'CONFLICT' && e.exitCode === 2 && e.extra.heads.length === 2,
  );
  assert.equal(h.heads('T1').length, 2);

  // successors rejected until resolved
  assert.throws(
    () => h.replace({ tradeId: 'T1', quantity: 5, author: 'dave' }),
    (e) => e.code === 'CONFLICT_UNRESOLVED' && e.exitCode === 2,
  );
  assert.throws(() => h.materialize('T1'), (e) => e.code === 'CONFLICT' && e.exitCode === 2);

  const heads = h.heads('T1');
  const r = h.resolve({ tradeId: 'T1', winner: heads[0], author: 'dave' });
  assert.equal(r.status, 'resolved');
  assert.equal(h.heads('T1').length, 1);
  const m = h.materialize('T1');
  assert.deepEqual(m.state, h.stateAt(heads[0]));
  assert.equal(m.reference.deterministic, true);
});

test('replace after cancel is rejected', () => {
  const { h } = setup();
  h.cancel({ tradeId: 'T1', author: 'bob' });
  assert.throws(
    () => h.replace({ tradeId: 'T1', price: 1, author: 'carol' }),
    (e) => e.code === 'CANCELLED' && e.exitCode === 1,
  );
  const m = h.materialize('T1');
  assert.equal(m.state.status, 'cancelled');
  assert.equal(m.margin.frozen, 0);
});

test('concurrent cancel wins over field modification; later modifications rejected', () => {
  const { h, base } = setup();
  h.replace({ tradeId: 'T1', price: 101, author: 'bob' });
  const r = h.cancel({ tradeId: 'T1', base, author: 'carol' });
  assert.equal(r.status, 'merged');
  assert.equal(r.note, 'cancel_wins');
  const m = h.materialize('T1');
  assert.equal(m.state.status, 'cancelled');
  assert.equal(m.margin.frozen, 0);
  assert.throws(
    () => h.replace({ tradeId: 'T1', quantity: 3, author: 'dave' }),
    (e) => e.code === 'CANCELLED',
  );
});

test('concurrent modify against a cancelled side is rejected (cancel wins)', () => {
  const { h, base } = setup();
  h.cancel({ tradeId: 'T1', author: 'bob' });
  assert.throws(
    () => h.replace({ tradeId: 'T1', base, price: 50, author: 'carol' }),
    (e) => e.code === 'CANCELLED' && e.exitCode === 1,
  );
});

test('author sequence numbers are monotonic per author', () => {
  const { h } = setup();
  h.replace({ tradeId: 'T1', price: 101, author: 'alice' });
  h.replace({ tradeId: 'T1', price: 102, author: 'alice' });
  const seqs = h
    .tradeRevisions('T1')
    .filter((r) => r.author === 'alice')
    .map((r) => r.seq)
    .sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('reference check enumerates permutations for merged history', () => {
  const { h, base } = setup();
  h.replace({ tradeId: 'T1', price: 101, author: 'bob' });
  h.replace({ tradeId: 'T1', base, quantity: 20, author: 'carol' });
  const hist = h.history('T1');
  assert.equal(hist.reference.checked, true);
  assert.ok(hist.reference.causalOrders > 1);
  assert.equal(hist.reference.deterministic, true);
  assert.deepEqual(hist.reference.winning, [{ price: 101, quantity: 20, status: 'active' }]);
});
