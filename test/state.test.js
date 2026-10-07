'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRuleSet } = require('../src/rules');
const { evaluate } = require('../src/engine');
const { StateStore } = require('../src/state');

const RULE = 'high = [a3t0r2c*h1]\n';

function txs() {
  return [
    { id: 't1', account: 'acct1', amount: 100, hour: 10, region: 'domestic', channel: 'pos', history: 'clean' },
    { id: 't2', account: 'acct1', amount: 250, hour: 11, region: 'domestic', channel: 'pos', history: 'clean' },
    { id: 't3', account: 'acct2', amount: 30000, hour: 3, region: 'sanctioned', channel: 'atm', history: 'flagged' },
  ];
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-state-'));
  const store = new StateStore(dir);
  const rs = loadRuleSet(RULE);
  const transactions = txs();
  const decisions = evaluate(rs, transactions);
  return { dir, store, transactions, decisions };
}

// Acceptance D: crash at each explicit fault point, recover, retry apply;
// quota must be deducted exactly once.
for (const fp of ['FP1', 'FP2', 'FP3']) {
  test(`crash at ${fp}: recovery then retry deducts quota exactly once`, () => {
    const { store, transactions, decisions } = setup();
    assert.throws(
      () => store.apply('batch-1', transactions, decisions, fp),
      (err) => err.code === 'FAULT_INJECTED'
    );
    const rec = store.recover();
    if (fp === 'FP1') {
      // Crash before the journal was written: nothing to recover.
      assert.equal(rec.recovered, false);
    } else {
      assert.equal(rec.recovered, true);
      assert.equal(rec.action, 'rollback');
    }
    // Retry after recovery succeeds and freezes only the two approved txs.
    const { state } = store.apply('batch-1', transactions, decisions);
    assert.equal(state.accounts.acct1.frozen, 350);
    assert.equal(state.accounts.acct2.frozen, 0); // rejected tx froze nothing
    assert.equal(state.history.length, 1);
  });
}

test('crash after commit but before journal cleanup: recover finalizes, no double deduct', () => {
  const { store, transactions, decisions } = setup();
  store.apply('batch-1', transactions, decisions);
  // Simulate the lost journal cleanup: a stale journal for the committed batch.
  store.writeJournal({ batchId: 'batch-1', decisions: [], deltas: {}, checkpoint: true });
  const rec = store.recover();
  assert.equal(rec.action, 'finalize');
  assert.equal(store.loadState().accounts.acct1.frozen, 350);
  // Re-applying the same batch is a conflict, not a second deduction.
  assert.throws(
    () => store.apply('batch-1', transactions, decisions),
    (err) => err.code === 'APPLY_CONFLICT'
  );
  assert.equal(store.loadState().accounts.acct1.frozen, 350);
});

test('unrecovered journal blocks apply with APPLY_CONFLICT', () => {
  const { store, transactions, decisions } = setup();
  assert.throws(() => store.apply('batch-1', transactions, decisions, 'FP2'));
  assert.throws(
    () => store.apply('batch-2', transactions, decisions),
    (err) => err.code === 'APPLY_CONFLICT'
  );
  store.recover();
  store.apply('batch-2', transactions, decisions);
  assert.equal(store.loadState().accounts.acct1.frozen, 350);
});

// Acceptance E: undo on an empty stack reports UNDO_EMPTY.
test('undo on empty history raises UNDO_EMPTY', () => {
  const { store } = setup();
  assert.throws(() => store.undo(), (err) => err.code === 'UNDO_EMPTY');
});

test('apply then undo restores pre-apply state; second undo is UNDO_EMPTY', () => {
  const { store, transactions, decisions } = setup();
  store.apply('batch-1', transactions, decisions);
  assert.equal(store.loadState().accounts.acct1.frozen, 350);
  const { undone } = store.undo();
  assert.equal(undone, 'batch-1');
  const state = store.loadState();
  assert.equal(state.history.length, 0);
  for (const acct of Object.values(state.accounts)) assert.equal(acct.frozen, 0);
  assert.throws(() => store.undo(), (err) => err.code === 'UNDO_EMPTY');
});

test('insufficient funds turns approval into failed tx without freeze', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-state-'));
  const store = new StateStore(dir);
  const rs = loadRuleSet(RULE);
  const big = [
    { id: 't1', account: 'acct9', amount: 2000000, hour: 10, region: 'domestic', channel: 'pos', history: 'clean' },
  ];
  const decisions = evaluate(rs, big);
  const { state, decisions: final } = store.apply('batch-1', big, decisions);
  assert.equal(final[0].decision, 'REJECT');
  assert.ok(final[0].rules.includes('INSUFFICIENT_FUNDS'));
  assert.equal(state.accounts.acct9.frozen, 0);
});
