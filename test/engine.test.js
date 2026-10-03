'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SettleError,
  Ledger,
  settleFull,
  settleIncremental,
  sortRows,
} = require('../src/engine');
const { canonicalRowOrder } = require('../src/cert');

// Acceptance A: normal run with NULL fee and a duplicate reversal.
test('A: netting with NULL fee and duplicate cancel', () => {
  const trades = [
    { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 100, fee: 5 },
    { trade_id: 't2', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: -40, fee: null },
    { trade_id: 't3', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 10, fee: null },
    { trade_id: 't4', ccy: 'EUR', counterparty: 'B', trade_date: '2026-10-01', amount: 7, fee: null },
  ];
  const events = [
    { type: 'cancel', trade_id: 't3' },
    { type: 'cancel', trade_id: 't3' }, // duplicate reversal: idempotent no-op
  ];
  const rows = sortRows(settleIncremental(trades, events));
  assert.deepEqual(rows, [
    { ccy: 'EUR', counterparty: 'B', trade_date: '2026-10-01', net_amount: 7, fee_total: null, trade_count: 1 },
    { ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', net_amount: 60, fee_total: 5, trade_count: 2 },
  ]);
});

// Acceptance B: incremental application of events equals a full recompute.
test('B: incremental ledger matches independent full recompute after each event', () => {
  const trades = [
    { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 100, fee: 5 },
    { trade_id: 't2', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: -30, fee: null },
    { trade_id: 't3', ccy: 'JPY', counterparty: 'C', trade_date: '2026-10-02', amount: 1000, fee: 2 },
    { trade_id: 't4', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-02', amount: 55, fee: 1 },
  ];
  const events = [
    { type: 'insert', trade: { trade_id: 't5', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 12, fee: null } },
    { type: 'cancel', trade_id: 't2' },
    { type: 'cancel', trade_id: 't3' },
    { type: 'insert', trade: { trade_id: 't6', ccy: 'JPY', counterparty: 'C', trade_date: '2026-10-02', amount: -250, fee: null } },
    { type: 'cancel', trade_id: 't3' }, // duplicate reversal
    { type: 'cancel', trade_id: 'nope' }, // unknown id: no-op
  ];
  const ledger = new Ledger();
  trades.forEach((t) => ledger.insert(t));
  const applied = [];
  for (const ev of events) {
    ledger.applyEvent(ev);
    applied.push(ev);
    const inc = canonicalRowOrder(sortRows(ledger.rows()));
    const full = canonicalRowOrder(sortRows(settleFull(trades, applied)));
    assert.deepEqual(inc, full, `mismatch after event ${JSON.stringify(ev)}`);
  }
});

// Acceptance D: empty inputs and all-NULL fee boundaries.
test('D: empty inputs produce zero rows', () => {
  assert.deepEqual(settleIncremental([], []), []);
  assert.deepEqual(settleFull([], []), []);
});

test('D: all-NULL fee group has fee_total NULL, not 0', () => {
  const trades = [
    { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 5, fee: null },
    { trade_id: 't2', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 6 },
  ];
  const [row] = settleIncremental(trades, []);
  assert.equal(row.net_amount, 11);
  assert.equal(row.fee_total, null);
});

test('D: group emptied by cancels disappears entirely', () => {
  const trades = [
    { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 5, fee: 1 },
  ];
  const rows = settleIncremental(trades, [{ type: 'cancel', trade_id: 't1' }]);
  assert.deepEqual(rows, []);
});

test('E_DUP_TRADE on duplicate trade_id', () => {
  const t = { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 5, fee: null };
  assert.throws(() => settleIncremental([t, t], []), (err) => err instanceof SettleError && err.code === 'E_DUP_TRADE');
  assert.throws(
    () => settleIncremental([t], [{ type: 'insert', trade: t }]),
    (err) => err.code === 'E_DUP_TRADE',
  );
});

test('E_BAD_NULL on NULL required fields', () => {
  const bad = { trade_id: 't1', ccy: null, counterparty: 'A', trade_date: '2026-10-01', amount: 5 };
  assert.throws(() => settleIncremental([bad], []), (err) => err.code === 'E_BAD_NULL');
  const noAmount = { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: null };
  assert.throws(() => settleIncremental([noAmount], []), (err) => err.code === 'E_BAD_NULL');
  assert.throws(
    () => settleIncremental([], [{ type: 'cancel', trade_id: null }]),
    (err) => err.code === 'E_BAD_NULL',
  );
});

test('E_BAD_EVENT on unknown event type', () => {
  assert.throws(() => settleIncremental([], [{ type: 'explode' }]), (err) => err.code === 'E_BAD_EVENT');
});

test('netting groups by (ccy, counterparty, trade_date) only', () => {
  const trades = [
    { trade_id: 't1', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', amount: 10, fee: 1 },
    { trade_id: 't2', ccy: 'USD', counterparty: 'A', trade_date: '2026-10-02', amount: 20, fee: 2 },
    { trade_id: 't3', ccy: 'USD', counterparty: 'B', trade_date: '2026-10-01', amount: 30, fee: 3 },
  ];
  const rows = sortRows(settleIncremental(trades, []));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', net_amount: 10, fee_total: 1, trade_count: 1 });
});
