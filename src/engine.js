import { SettleError, E } from './errors.js';
import { validateTrade, validateEvent } from './io.js';
import { DecimalAcc } from './decimal.js';

// Netting engine: groups trades by (currency, counterparty, trade_date)
// and maintains per-group aggregates incrementally. Events (insert/revoke)
// update only the affected group — no full recompute. Sums use exact
// decimal accumulation so results are independent of update order.

function groupKeyOf(trade) {
  return JSON.stringify([trade.currency, trade.counterparty, trade.trade_date]);
}

function emptyGroup(currency, counterparty, trade_date) {
  return {
    currency,
    counterparty,
    trade_date,
    net: new DecimalAcc(),
    fee: new DecimalAcc(),
    fee_nonnull: 0,
    trade_count: 0,
  };
}

export class NettingEngine {
  constructor() {
    this.trades = new Map(); // trade_id -> trade
    this.groups = new Map(); // group key -> aggregate
  }

  // sign: +1 add, -1 remove. Touches exactly one group.
  applyTrade(trade, sign) {
    const key = groupKeyOf(trade);
    let g = this.groups.get(key);
    if (!g) {
      g = emptyGroup(trade.currency, trade.counterparty, trade.trade_date);
      this.groups.set(key, g);
    }
    g.net.add(trade.amount, sign);
    if (trade.fee !== null && trade.fee !== undefined) {
      g.fee.add(trade.fee, sign);
      g.fee_nonnull += sign;
    }
    g.trade_count += sign;
    if (g.trade_count === 0) this.groups.delete(key);
  }

  addTrade(trade, source = 'trades') {
    validateTrade(trade, source);
    if (this.trades.has(trade.trade_id)) {
      throw new SettleError(E.DUP_TRADE, `${source}: duplicate trade_id ${trade.trade_id}`);
    }
    this.trades.set(trade.trade_id, trade);
    this.applyTrade(trade, +1);
  }

  revokeTrade(tradeId, source = 'events') {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      throw new SettleError(E.UNKNOWN_TRADE, `${source}: cannot revoke unknown trade_id ${tradeId}`);
    }
    this.trades.delete(tradeId);
    this.applyTrade(trade, -1);
  }

  applyEvent(ev, source = 'events') {
    validateEvent(ev, source);
    if (ev.op === 'insert') this.addTrade(ev.trade, source);
    else if (ev.op === 'revoke') this.revokeTrade(ev.trade_id, source);
  }

  loadTrades(trades) {
    for (const t of trades) this.addTrade(t, 'trades.jsonl');
  }

  applyEvents(events) {
    for (const ev of events) this.applyEvent(ev, 'events.jsonl');
  }

  // Canonical row order: currency, counterparty, trade_date ascending.
  rows() {
    const out = [];
    for (const g of this.groups.values()) {
      const feeSum = g.fee_nonnull > 0 ? g.fee.toNumber() : null; // all-NULL group -> NULL, not 0
      out.push({
        currency: g.currency,
        counterparty: g.counterparty,
        trade_date: g.trade_date,
        net_amount: g.net.toNumber(),
        fee_sum: feeSum,
        avg_fee: feeSum === null ? null : feeSum / g.fee_nonnull,
        trade_count: g.trade_count,
      });
    }
    out.sort((a, b) => {
      if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
      if (a.counterparty !== b.counterparty) return a.counterparty < b.counterparty ? -1 : 1;
      return a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0;
    });
    return out;
  }
}

// Independent full-enumeration recompute (reference implementation used
// to cross-check the incremental engine).
export function fullRecompute(trades, events) {
  const active = new Map();
  for (const t of trades) {
    validateTrade(t, 'trades.jsonl');
    if (active.has(t.trade_id)) {
      throw new SettleError(E.DUP_TRADE, `trades.jsonl: duplicate trade_id ${t.trade_id}`);
    }
    active.set(t.trade_id, t);
  }
  for (const ev of events) {
    validateEvent(ev, 'events.jsonl');
    if (ev.op === 'insert') {
      if (active.has(ev.trade.trade_id)) {
        throw new SettleError(E.DUP_TRADE, `events.jsonl: duplicate trade_id ${ev.trade.trade_id}`);
      }
      active.set(ev.trade.trade_id, ev.trade);
    } else {
      if (!active.has(ev.trade_id)) {
        throw new SettleError(E.UNKNOWN_TRADE, `events.jsonl: cannot revoke unknown trade_id ${ev.trade_id}`);
      }
      active.delete(ev.trade_id);
    }
  }
  const engine = new NettingEngine();
  for (const t of active.values()) engine.addTrade(t, 'recompute');
  return engine.rows();
}
