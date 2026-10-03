import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NettingEngine, fullRecompute } from '../src/engine.js';

// 50k rows: incremental engine vs full recompute, local performance bound.
test('50k trades + 10k events complete and match full recompute', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cps = Array.from({ length: 50 }, (_, i) => `CP${i}`);
  const ccs = ['USD', 'EUR', 'JPY', 'GBP'];
  const dates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const mk = (id) => ({
    trade_id: id,
    counterparty: pick(cps),
    currency: pick(ccs),
    trade_date: pick(dates),
    amount: Math.round(rand() * 1e6 - 5e5) / 100,
    fee: rand() < 0.25 ? null : Math.round(rand() * 1000) / 100,
  });
  const trades = [];
  for (let i = 0; i < 50000; i++) trades.push(mk(`t${i}`));
  const events = [];
  const live = new Set(trades.map((t) => t.trade_id));
  for (let i = 0; i < 10000; i++) {
    if (rand() < 0.5) {
      const id = `e${i}`;
      events.push({ op: 'insert', trade: mk(id) });
      live.add(id);
    } else {
      const id = `t${Math.floor(rand() * 50000)}`;
      if (!live.has(id)) continue;
      live.delete(id);
      events.push({ op: 'revoke', trade_id: id });
    }
  }
  const t0 = Date.now();
  const engine = new NettingEngine();
  engine.loadTrades(trades);
  engine.applyEvents(events);
  const incRows = engine.rows();
  const refRows = fullRecompute(trades, events);
  const elapsed = Date.now() - t0;
  assert.deepEqual(incRows, refRows);
  assert.ok(elapsed < 30000, `took ${elapsed}ms`);
  console.log(`50k trades + ${events.length} events: ${elapsed}ms, ${incRows.length} groups`);
});
