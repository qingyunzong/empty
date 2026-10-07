'use strict';

const { merkleRoot } = require('./merkle');

const WINDOW_MS = 10_000;

function windowOf(ts) {
  return Math.floor(ts / WINDOW_MS);
}

function keyOf(row) {
  return `${row.orderId}${row.symbol}`;
}

function cancelIdentity(cancel) {
  return `${cancel.orderId}${cancel.symbol}${cancel.qty}${cancel.ts}`;
}

function byTsThenLine(a, b) {
  return a.ts - b.ts || a.line - b.line;
}

// Deterministic event-time join. Both streams are re-sorted into canonical
// (ts, line) order, so output is independent of input line order (each side
// may arrive arbitrarily out of order against its own watermark).
//
// Semantics:
//  - A trade publishes a fill in its window, net of cancels in the SAME window.
//  - A cancel in a LATER window than the trade it consumes emits a late-join
//    correction row (negative qty in the cancel's window); the already
//    published fill is left untouched.
//  - A cancel may consume several trades of the same key (FIFO by ts) and a
//    trade's remainder stays open to cancels in subsequent windows.
//  - A duplicate cancel (same orderId/symbol/qty/ts) takes effect only once.
//  - Cancel qty with no open trade qty in its own or an earlier window is an
//    orphan: listed separately, never a negative fill.
function joinStreams(trades, cancels) {
  const sortedTrades = [...trades].sort(byTsThenLine);

  const seen = new Set();
  const dedupedCancels = [];
  let duplicateCancels = 0;
  for (const cancel of cancels) {
    const identity = cancelIdentity(cancel);
    if (seen.has(identity)) {
      duplicateCancels += 1;
      continue;
    }
    seen.add(identity);
    dedupedCancels.push(cancel);
  }
  const sortedCancels = dedupedCancels.sort(byTsThenLine);

  const slots = sortedTrades.map((trade) => ({
    trade,
    remaining: trade.qty,
    sameWindowConsumed: 0,
    sameWindowCancelLines: [],
  }));
  const byKey = new Map();
  for (const slot of slots) {
    const key = keyOf(slot.trade);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(slot);
  }

  const lateJoins = [];
  const orphans = [];

  for (const cancel of sortedCancels) {
    const cancelWin = windowOf(cancel.ts);
    let left = cancel.qty;
    const key = keyOf(cancel);
    const candidates = byKey.get(key);
    if (candidates) {
      for (const slot of candidates) {
        if (left <= 0) break;
        if (slot.remaining <= 0) continue;
        const tradeWin = windowOf(slot.trade.ts);
        if (tradeWin > cancelWin) continue; // cannot cancel a future window
        const take = Math.min(slot.remaining, left);
        slot.remaining -= take;
        left -= take;
        if (tradeWin === cancelWin) {
          slot.sameWindowConsumed += take;
          slot.sameWindowCancelLines.push(cancel.line);
        } else {
          lateJoins.push({
            orderId: cancel.orderId,
            symbol: cancel.symbol,
            qty: -take,
            win: cancelWin,
            late: true,
            proof: merkleRoot([`T${slot.trade.line}`, `C${cancel.line}`]),
            tradeLine: slot.trade.line,
            cancelLine: cancel.line,
          });
        }
      }
    }
    if (left > 0) {
      orphans.push({
        orderId: cancel.orderId,
        symbol: cancel.symbol,
        qty: left,
        ts: cancel.ts,
        win: cancelWin,
        line: cancel.line,
        reason: candidates ? 'insufficient-open-qty' : 'unknown-order',
      });
    }
  }

  const fills = slots.map((slot) => ({
    orderId: slot.trade.orderId,
    symbol: slot.trade.symbol,
    qty: slot.trade.qty - slot.sameWindowConsumed,
    win: windowOf(slot.trade.ts),
    proof: merkleRoot([
      `T${slot.trade.line}`,
      ...slot.sameWindowCancelLines.map((line) => `C${line}`),
    ]),
    tradeLine: slot.trade.line,
  }));

  const rows = [
    ...fills.map((fill) => ({ ...fill, late: false })),
    ...lateJoins,
  ].sort((a, b) => a.win - b.win
    || Number(a.late) - Number(b.late)
    || a.tradeLine - b.tradeLine
    || (a.cancelLine || 0) - (b.cancelLine || 0));

  const symbols = {};
  for (const slot of slots) {
    const { symbol, price } = slot.trade;
    if (!symbols[symbol]) symbols[symbol] = { qty: 0, amountCents: 0 };
    symbols[symbol].qty += slot.remaining;
    symbols[symbol].amountCents += slot.remaining * price;
  }

  const watermark = (rowsList) =>
    (rowsList.length ? Math.max(...rowsList.map((row) => row.ts)) : null);

  return {
    rows,
    fills,
    lateJoins,
    orphans,
    symbols,
    stats: {
      trades: sortedTrades.length,
      cancels: sortedCancels.length,
      duplicateCancels,
      watermarks: { trades: watermark(trades), cancels: watermark(cancels) },
    },
  };
}

module.exports = { joinStreams, windowOf, WINDOW_MS };
