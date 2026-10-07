'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { joinStreams, windowOf } = require('../lib/join');

// Independent brute-force reference: straight-line re-implementation of the
// documented semantics, deliberately sharing no code with lib/join.js.
function reference(trades, cancels) {
  const dedup = new Map();
  for (const c of cancels) {
    const id = `${c.orderId}|${c.symbol}|${c.qty}|${c.ts}`;
    if (!dedup.has(id)) dedup.set(id, c);
  }
  const cs = [...dedup.values()].sort((a, b) => a.ts - b.ts || a.line - b.line);
  const open = trades
    .map((t) => ({ t, left: t.qty, sameWin: 0 }))
    .sort((a, b) => a.t.ts - b.t.ts || a.t.line - b.t.line);
  const late = [];
  const orphans = [];
  for (const c of cs) {
    const cw = windowOf(c.ts);
    let need = c.qty;
    let any = false;
    for (const slot of open) {
      if (slot.t.orderId !== c.orderId || slot.t.symbol !== c.symbol) continue;
      any = true;
      if (windowOf(slot.t.ts) > cw || slot.left <= 0) continue;
      const take = Math.min(slot.left, need);
      slot.left -= take;
      need -= take;
      if (windowOf(slot.t.ts) === cw) slot.sameWin += take;
      else late.push({ orderId: c.orderId, symbol: c.symbol, qty: -take, win: cw });
    }
    if (need > 0) {
      orphans.push({
        orderId: c.orderId, symbol: c.symbol, qty: need, win: cw,
        reason: any ? 'insufficient-open-qty' : 'unknown-order',
      });
    }
  }
  const symbols = {};
  for (const slot of open) {
    const s = slot.t.symbol;
    if (!symbols[s]) symbols[s] = { qty: 0, amountCents: 0 };
    symbols[s].qty += slot.left;
    symbols[s].amountCents += slot.left * slot.t.price;
  }
  const fills = open.map((slot) => ({
    orderId: slot.t.orderId,
    symbol: slot.t.symbol,
    qty: slot.t.qty - slot.sameWin,
    win: windowOf(slot.t.ts),
  }));
  return { fills, late, orphans, symbols };
}

const pick = (result) => ({
  fills: result.fills
    .map(({ orderId, symbol, qty, win }) => ({ orderId, symbol, qty, win }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  late: result.lateJoins
    .map(({ orderId, symbol, qty, win }) => ({ orderId, symbol, qty, win }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  orphans: result.orphans
    .map(({ orderId, symbol, qty, win, reason }) => ({ orderId, symbol, qty, win, reason }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  symbols: result.symbols,
});

const pickRef = (result) => ({
  fills: result.fills
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  late: result.late
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  orphans: result.orphans
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  symbols: result.symbols,
});

test('D: enumerate every cancel subset over <=8 orders and compare', () => {
  const trades = [
    { orderId: 'o1', symbol: 'A', qty: 100, price: 500, ts: 1_000, line: 1 },
    { orderId: 'o2', symbol: 'A', qty: 40, price: 510, ts: 12_000, line: 2 },
    { orderId: 'o3', symbol: 'B', qty: 10, price: 99, ts: 8_000, line: 3 },
    { orderId: 'o4', symbol: 'B', qty: 25, price: 101, ts: 21_000, line: 4 },
    { orderId: 'o5', symbol: 'A', qty: 60, price: 505, ts: 5_000, line: 5 },
  ];
  // 8 cancels: in-window, cross-window, duplicate, over-cancel, orphan kinds.
  const cancels = [
    { orderId: 'o1', symbol: 'A', qty: 30, ts: 2_000, line: 1 },
    { orderId: 'o1', symbol: 'A', qty: 20, ts: 11_000, line: 2 },
    { orderId: 'o1', symbol: 'A', qty: 30, ts: 2_000, line: 3 }, // duplicate of line 1
    { orderId: 'o5', symbol: 'A', qty: 200, ts: 6_000, line: 4 }, // over-cancel
    { orderId: 'o4', symbol: 'B', qty: 10, ts: 22_000, line: 5 },
    { orderId: 'o2', symbol: 'A', qty: 15, ts: 3_000, line: 6 }, // earlier window: orphan
    { orderId: 'zz', symbol: 'A', qty: 7, ts: 4_000, line: 7 },  // unknown order
    { orderId: 'o3', symbol: 'B', qty: 10, ts: 9_999, line: 8 }, // full cancel, same window
  ];
  assert.ok(trades.length <= 8 && cancels.length <= 8);

  for (let mask = 0; mask < (1 << cancels.length); mask += 1) {
    const subset = cancels.filter((_, i) => mask & (1 << i));
    const actual = pick(joinStreams(trades, subset));
    const expected = pickRef(reference(trades, subset));
    assert.deepEqual(actual, expected, `mismatch for subset mask ${mask.toString(2)}`);
  }
});
