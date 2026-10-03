import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NettingEngine, fullRecompute } from '../src/engine.js';

function trade(id, overrides = {}) {
  return {
    trade_id: id,
    counterparty: 'CP1',
    currency: 'USD',
    trade_date: '2026-10-01',
    amount: 100,
    fee: 10,
    ...overrides,
  };
}

// Acceptance A: normal flow with NULL fee and duplicate reversal (冲正).
test('A: netting with NULL fee and reversal events', () => {
  const engine = new NettingEngine();
  engine.loadTrades([
    trade('t1', { amount: 100, fee: 10 }),
    trade('t2', { amount: -30, fee: null }), // NULL fee
    trade('t3', { amount: 50, fee: 5, counterparty: 'CP2' }),
    trade('t4', { amount: 999, fee: 1 }),    // will be revoked
  ]);
  engine.applyEvents([
    { op: 'revoke', trade_id: 't4' },                       // 冲正
    { op: 'insert', trade: trade('t5', { amount: 7, fee: null }) },
  ]);
  const rows = engine.rows();
  assert.equal(rows.length, 2);
  const cp1 = rows.find((r) => r.counterparty === 'CP1');
  assert.equal(cp1.net_amount, 77); // 100 - 30 + 7
  assert.equal(cp1.fee_sum, 10);    // NULL fees ignored
  assert.equal(cp1.avg_fee, 10);
  assert.equal(cp1.trade_count, 3);
  const cp2 = rows.find((r) => r.counterparty === 'CP2');
  assert.equal(cp2.net_amount, 50);
});

test('A: duplicate trade_id rejected', () => {
  const engine = new NettingEngine();
  engine.loadTrades([trade('t1')]);
  assert.throws(() => engine.loadTrades([trade('t1')]), { code: 'E_DUP_TRADE' });
  assert.throws(
    () => engine.applyEvents([{ op: 'insert', trade: trade('t1') }]),
    { code: 'E_DUP_TRADE' },
  );
});

test('A: NULL in required field rejected as E_BAD_NULL', () => {
  const engine = new NettingEngine();
  assert.throws(
    () => engine.loadTrades([trade('t1', { amount: null })]),
    { code: 'E_BAD_NULL' },
  );
  assert.throws(
    () => engine.applyEvents([{ op: 'revoke', trade_id: null }]),
    { code: 'E_BAD_NULL' },
  );
});

// Acceptance B: incremental insert/revoke equals independent full recompute.
test('B: incremental result equals full recompute (directed)', () => {
  const trades = [
    trade('t1', { amount: 10, fee: 1 }),
    trade('t2', { amount: 20, fee: null, currency: 'EUR' }),
    trade('t3', { amount: -5, fee: 2, trade_date: '2026-10-02' }),
  ];
  const events = [
    { op: 'insert', trade: trade('t4', { amount: 3, fee: 3 }) },
    { op: 'revoke', trade_id: 't2' },
    { op: 'insert', trade: trade('t5', { amount: 8, fee: null, currency: 'EUR' }) },
    { op: 'revoke', trade_id: 't5' },
  ];
  const engine = new NettingEngine();
  engine.loadTrades(trades);
  engine.applyEvents(events);
  assert.deepEqual(engine.rows(), fullRecompute(trades, events));
});

test('B: randomized incremental vs full recompute', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cps = ['A', 'B', 'C'];
  const ccs = ['USD', 'EUR'];
  const dates = ['2026-10-01', '2026-10-02'];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const mk = (id) => trade(id, {
    counterparty: pick(cps),
    currency: pick(ccs),
    trade_date: pick(dates),
    amount: Math.round(rand() * 2000 - 1000) / 10,
    fee: rand() < 0.3 ? null : Math.round(rand() * 100) / 10,
  });
  const trades = [];
  for (let i = 0; i < 200; i++) trades.push(mk(`t${i}`));
  const events = [];
  for (let i = 0; i < 150; i++) {
    if (rand() < 0.5) events.push({ op: 'insert', trade: mk(`e${i}`) });
    else events.push({ op: 'revoke', trade_id: `t${Math.floor(rand() * 200)}` });
  }
  // keep only valid revoke targets in order
  const live = new Set(trades.map((t) => t.trade_id));
  const validEvents = [];
  for (const ev of events) {
    if (ev.op === 'revoke') {
      if (!live.has(ev.trade_id)) continue;
      live.delete(ev.trade_id);
    } else {
      live.add(ev.trade.trade_id);
    }
    validEvents.push(ev);
  }
  const engine = new NettingEngine();
  engine.loadTrades(trades);
  engine.applyEvents(validEvents);
  assert.deepEqual(engine.rows(), fullRecompute(trades, validEvents));
});

// Acceptance D: empty and all-NULL boundaries.
test('D: empty input yields empty rows', () => {
  const engine = new NettingEngine();
  assert.deepEqual(engine.rows(), []);
  assert.deepEqual(fullRecompute([], []), []);
});

test('D: all-NULL fee group has NULL fee_sum and NULL avg_fee, not 0', () => {
  const engine = new NettingEngine();
  engine.loadTrades([
    trade('t1', { fee: null }),
    trade('t2', { fee: null, amount: -100 }),
  ]);
  const [row] = engine.rows();
  assert.equal(row.net_amount, 0);
  assert.equal(row.fee_sum, null);
  assert.equal(row.avg_fee, null);
  assert.equal(row.trade_count, 2);
});

test('D: fully revoked group disappears', () => {
  const engine = new NettingEngine();
  engine.loadTrades([trade('t1')]);
  engine.applyEvents([{ op: 'revoke', trade_id: 't1' }]);
  assert.deepEqual(engine.rows(), []);
});

test('D: revoking unknown trade rejected', () => {
  const engine = new NettingEngine();
  assert.throws(
    () => engine.applyEvents([{ op: 'revoke', trade_id: 'nope' }]),
    { code: 'E_UNKNOWN_TRADE' },
  );
});
