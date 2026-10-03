'use strict';

const rel = require('./relalg');

class SettleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettleError';
    this.code = code;
  }
}

const TRADE_FIELDS = ['trade_id', 'ccy', 'counterparty', 'trade_date', 'amount', 'fee'];
const REQUIRED_FIELDS = ['trade_id', 'ccy', 'counterparty', 'trade_date'];

function isNull(v) {
  return v === null || v === undefined;
}

// Validates a raw trade object; returns a normalized trade with fee=null when absent.
function validateTrade(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettleError('E_BAD_INPUT', `${where}: trade must be an object`);
  }
  for (const f of REQUIRED_FIELDS) {
    if (isNull(raw[f])) {
      throw new SettleError('E_BAD_NULL', `${where}: required field "${f}" is NULL`);
    }
  }
  if (isNull(raw.amount)) {
    throw new SettleError('E_BAD_NULL', `${where}: required field "amount" is NULL`);
  }
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount)) {
    throw new SettleError('E_BAD_INPUT', `${where}: amount must be a finite number`);
  }
  if (!isNull(raw.fee) && (typeof raw.fee !== 'number' || !Number.isFinite(raw.fee))) {
    throw new SettleError('E_BAD_INPUT', `${where}: fee must be a finite number or NULL`);
  }
  return {
    trade_id: String(raw.trade_id),
    ccy: String(raw.ccy),
    counterparty: String(raw.counterparty),
    trade_date: String(raw.trade_date),
    amount: raw.amount,
    fee: isNull(raw.fee) ? null : raw.fee,
  };
}
function validateEvent(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettleError('E_BAD_INPUT', `${where}: event must be an object`);
  }
  if (raw.type === 'insert') {
    return { type: 'insert', trade: validateTrade(raw.trade, `${where}.trade`) };
  }
  if (raw.type === 'cancel') {
    if (isNull(raw.trade_id)) {
      throw new SettleError('E_BAD_NULL', `${where}: cancel event has NULL trade_id`);
    }
    return { type: 'cancel', trade_id: String(raw.trade_id) };
  }
  throw new SettleError('E_BAD_EVENT', `${where}: unknown event type "${raw.type}"`);
}

// Incremental ledger: applies inserts/cancels and maintains per-group sums,
// so appending an event recomputes only the affected (ccy, counterparty, date) group.
class Ledger {
  constructor() {
    this.active = new Map(); // trade_id -> trade (currently active)
    this.seen = new Set(); // every trade_id ever inserted (for duplicate detection)
    this.groups = new Map(); // groupKey -> aggregate state
  }

  static groupKey(t) {
    return JSON.stringify([t.ccy, t.counterparty, t.trade_date]);
  }

  insert(rawTrade, where = 'trade') {
    const t = validateTrade(rawTrade, where);
    if (this.seen.has(t.trade_id)) {
      throw new SettleError('E_DUP_TRADE', `${where}: duplicate trade_id "${t.trade_id}"`);
    }
    this.seen.add(t.trade_id);
    this.active.set(t.trade_id, t);
    this.#applyToGroup(t, +1);
    return t;
  }

  // Idempotent: cancelling an unknown or already-cancelled trade is a no-op.
  cancel(tradeId) {
    const t = this.active.get(tradeId);
    if (!t) return false;
    this.active.delete(tradeId);
    this.#applyToGroup(t, -1);
    return true;
  }

  applyEvent(rawEvent, where = 'event') {
    const ev = validateEvent(rawEvent, where);
    if (ev.type === 'insert') this.insert(ev.trade, `${where}.trade`);
    else this.cancel(ev.trade_id);
    return ev;
  }

  #applyToGroup(t, sign) {
    const key = Ledger.groupKey(t);
    let g = this.groups.get(key);
    if (!g) {
      g = {
        ccy: t.ccy,
        counterparty: t.counterparty,
        trade_date: t.trade_date,
        amount_sum: 0,
        fee_sum: 0,
        fee_count: 0,
        trade_count: 0,
      };
      this.groups.set(key, g);
    }
    g.amount_sum += sign * t.amount;
    if (t.fee !== null) {
      g.fee_sum += sign * t.fee;
      g.fee_count += sign;
    }
    g.trade_count += sign;
    if (g.trade_count === 0) this.groups.delete(key); // empty group disappears
  }

  rows() {
    const out = [];
    for (const g of this.groups.values()) {
      out.push({
        ccy: g.ccy,
        counterparty: g.counterparty,
        trade_date: g.trade_date,
        net_amount: round6(g.amount_sum),
        fee_total: g.fee_count > 0 ? round6(g.fee_sum) : null, // all-NULL fee group stays NULL
        trade_count: g.trade_count,
      });
    }
    return out;
  }
}

// Full recompute from scratch, expressed with the relational algebra core:
// union of base trades and event inserts, minus cancelled ids, then grouped
// aggregation. This is the independent reference for the incremental Ledger.
function settleFull(trades, events) {
  const inserted = [];
  const cancelledIds = new Set();
  for (const ev of events) {
    const e = validateEvent(ev, 'events');
    if (e.type === 'insert') inserted.push(e.trade);
    else cancelledIds.add(e.trade_id);
  }
  const base = trades.map((t, i) => validateTrade(t, `trades[${i}]`));
  const all = rel.union(rel.project(base, TRADE_FIELDS), rel.project(inserted, TRADE_FIELDS));
  const active = rel.select(all, (r) => !cancelledIds.has(r.trade_id));
  const rows = rel.aggregate(active, ['ccy', 'counterparty', 'trade_date'], [
    { fn: 'sum', col: 'amount', as: 'net_amount' },
    { fn: 'sum', col: 'fee', as: 'fee_total' },
    { fn: 'count', col: null, as: 'trade_count' },
  ]);
  for (const r of rows) {
    r.net_amount = round6(r.net_amount);
    r.fee_total = r.fee_total === null ? null : round6(r.fee_total);
  }
  return rows;
}

function settleIncremental(trades, events) {
  const ledger = new Ledger();
  trades.forEach((t, i) => ledger.insert(t, `trades[${i}]`));
  events.forEach((e, i) => ledger.applyEvent(e, `events[${i}]`));
  return ledger.rows();
}

// Deterministic total order for result rows (canonical row order).
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    for (const k of ['ccy', 'counterparty', 'trade_date']) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  });
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

module.exports = {
  SettleError,
  Ledger,
  validateTrade,
  validateEvent,
  settleFull,
  settleIncremental,
  sortRows,
  TRADE_FIELDS,
};
