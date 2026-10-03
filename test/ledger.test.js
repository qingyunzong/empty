import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Conflict, propose, finalize, correct, rollback, tipLevel, report } from '../src/ledger.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const store = new Store(dir);
  store.load();
  return { store, dir };
}

function fundedStore() {
  const ctx = makeStore();
  ctx.store.state.budgets = { alice: 100, bob: 100, carol: 100 };
  return ctx;
}

test('finalize builds a chained block with level, parent hash, crc, deltas and index', () => {
  const { store } = fundedStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  propose(store, { id: 't2', from: 'bob', to: 'carol', amount: 4 });
  const b1 = finalize(store);
  assert.equal(b1.level, 1);
  assert.equal(b1.parent, 'GENESIS');
  assert.match(b1.crc, /^[0-9a-f]{8}$/);
  assert.match(b1.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(b1.deltas, { alice: 10, bob: -6, carol: -4 });
  assert.deepEqual(b1.index.map((e) => e.id), ['t1', 't2']);
  propose(store, { id: 't3', from: 'carol', to: 'alice', amount: 2 });
  const b2 = finalize(store);
  assert.equal(b2.level, 2);
  assert.equal(b2.parent, b1.hash);
});

test('budget caps net outflow across batches', () => {
  const { store } = makeStore();
  store.state.budgets = { alice: 10 };
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 8 });
  finalize(store);
  propose(store, { id: 't2', from: 'alice', to: 'bob', amount: 5 });
  assert.throws(() => finalize(store), (e) => e instanceof Conflict && /NO_SETTLEABLE/.test(e.message));
});

test('correct middle batch rolls back descendants, keeps unrelated batches final', () => {
  const { store, dir } = fundedStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  propose(store, { id: 't2', from: 'bob', to: 'carol', amount: 5 });
  const b1 = finalize(store);
  propose(store, { id: 't3', from: 'alice', to: 'carol', amount: 20 });
  const b2 = finalize(store);
  propose(store, { id: 't4', from: 'carol', to: 'alice', amount: 7 });
  const b3 = finalize(store);
  assert.equal(tipLevel(store.state), 3);

  const { block: nb2, rolled } = correct(store, 2);
  assert.deepEqual(rolled.map((b) => b.hash).sort(), [b2.hash, b3.hash].sort());
  assert.equal(store.state.levels['1'], b1.hash, 'unrelated earlier batch stays final');
  assert.equal(store.state.levels['2'], nb2.hash);
  assert.equal(store.state.levels['3'], undefined);
  assert.ok(store.state.rolledBack.includes(b2.hash));
  assert.ok(store.state.rolledBack.includes(b3.hash));
  assert.notEqual(nb2.hash, b2.hash);
  assert.equal(nb2.parent, b1.hash);
  assert.deepEqual(nb2.transfers, ['t3', 't4'], 'rolled-back transfers are re-selected under retained budget');

  const state = report(store);
  assert.deepEqual(state.settled, ['t1', 't2', 't3', 't4']);
  assert.deepEqual(state.pending, []);
  assert.equal(state.balances.alice, 10 + 20 - 7);

  const reloaded = new Store(dir);
  reloaded.load();
  assert.equal(reloaded.state.levels['2'], nb2.hash);
  assert.equal(tipLevel(reloaded.state), 2);
});

test('correct with tightened budget re-selects fewer transfers', () => {
  const { store } = fundedStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  const b1 = finalize(store);
  propose(store, { id: 't2', from: 'alice', to: 'carol', amount: 30 });
  propose(store, { id: 't3', from: 'alice', to: 'bob', amount: 30 });
  const b2 = finalize(store);
  assert.deepEqual(b2.transfers, ['t2', 't3']);
  store.state.budgets.alice = 40; // tighten: retained level-1 uses 10, 30 left
  const { block: nb2 } = correct(store, 2);
  assert.deepEqual(nb2.transfers, ['t2'], 'only one transfer fits the retained budget');
  assert.deepEqual([...store.state.pending], ['t3']);
  assert.equal(store.state.levels['1'], b1.hash);
});

test('rollback returns transfers to pending without re-settling', () => {
  const { store } = fundedStore();
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 10 });
  finalize(store);
  propose(store, { id: 't2', from: 'alice', to: 'carol', amount: 20 });
  const b2 = finalize(store);
  const rolled = rollback(store, 2);
  assert.deepEqual(rolled.map((b) => b.hash), [b2.hash]);
  assert.equal(tipLevel(store.state), 1);
  assert.deepEqual([...store.state.pending], ['t2']);
  assert.throws(() => rollback(store, 2), Conflict);
});

test('business conflicts: empty finalize, duplicate propose, unknown level', () => {
  const { store } = fundedStore();
  assert.throws(() => finalize(store), (e) => e instanceof Conflict && /NO_PENDING/.test(e.message));
  propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 1 });
  assert.throws(() => propose(store, { id: 't1', from: 'alice', to: 'bob', amount: 1 }), Conflict);
  assert.throws(() => correct(store, 9), (e) => e instanceof Conflict && /LEVEL_NOT_FINAL/.test(e.message));
});
