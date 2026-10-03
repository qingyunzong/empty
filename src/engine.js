'use strict';
// Core engine: dependency graph trade -> pair nets -> value-date queues -> settlement instructions.
// Deterministic: all dates are UTC calendar days, all ordering is (maturity, id).

const crypto = require('node:crypto');

const ZERO_HASH = '0'.repeat(64);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- calendar (fixed UTC) ----------

function isBusinessDay(dateStr, cal) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new EngineError('BAD_DATE', `invalid date ${dateStr}`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !cal.holidays.includes(dateStr);
}

function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// "following" convention: roll forward to next business day.
function adjust(dateStr, cal) {
  let d = dateStr;
  for (let i = 0; i < 3700; i++) {
    if (isBusinessDay(d, cal)) return d;
    d = nextDay(d);
  }
  throw new EngineError('CALENDAR', `no business day after ${dateStr}`);
}

// ---------- state ----------

function createState() {
  return {
    calendar: { version: 0, holidays: [] },
    trades: new Map(), // id -> {id,pair,amount,rate,valueDate,maturity,cancelled}
    liquidity: new Map(), // "CCY|YYYY-MM-DD" -> number
    compensations: [],
    events: 0,
    head: ZERO_HASH,
    // differential-maintenance cache for value-date queues
    cache: new Map(), // bucketKey -> Map(tradeId -> {covered, deficit?})
    dirty: new Set(),
  };
}

const remaining = (t) => r6(t.amount - t.cancelled);

// legs: positive amount = we deliver, negative = we receive. Buy base / sell quote.
function legsOf(t, portion) {
  const [base, quote] = t.pair.split('/');
  const amt = portion === undefined ? remaining(t) : portion;
  return [
    { ccy: base, amount: -amt },
    { ccy: quote, amount: r6(amt * t.rate) },
  ];
}

function tradeKeys(state, t) {
  const date = adjust(t.valueDate, state.calendar);
  const [base, quote] = t.pair.split('/');
  return [base + '|' + date, quote + '|' + date];
}

function touch(state, keys) {
  for (const k of keys) state.dirty.add(k);
}

// ---------- validation ----------

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_PAIR = /^[A-Z]{3}\/[A-Z]{3}$/;
const RE_CCY = /^[A-Z]{3}$/;

function need(cond, code, msg) {
  if (!cond) throw new EngineError(code, msg);
}

function validateTrade(ev) {
  need(typeof ev.id === 'string' && ev.id.length > 0, 'BAD_ID', 'trade id required');
  need(RE_PAIR.test(ev.pair), 'BAD_PAIR', `bad pair ${ev.pair}`);
  need(ev.pair.slice(0, 3) !== ev.pair.slice(4), 'BAD_PAIR', 'pair currencies must differ');
  need(Number.isFinite(ev.amount) && ev.amount > 0, 'BAD_AMOUNT', 'amount must be > 0');
  need(Number.isFinite(ev.rate) && ev.rate > 0, 'BAD_RATE', 'rate must be > 0');
  need(RE_DATE.test(ev.valueDate), 'BAD_DATE', `bad valueDate ${ev.valueDate}`);
  need(typeof ev.maturity === 'string' && !Number.isNaN(new Date(ev.maturity).getTime()),
    'BAD_MATURITY', 'maturity must be an ISO timestamp');
}

// ---------- events ----------

function applyEvent(state, ev) {
  need(ev && typeof ev === 'object', 'BAD_EVENT', 'event must be an object');
  switch (ev.type) {
    case 'trade': {
      validateTrade(ev);
      need(!state.trades.has(ev.id), 'DUP_ID', `duplicate trade id ${ev.id}`);
      const t = {
        id: ev.id, pair: ev.pair, amount: ev.amount, rate: ev.rate,
        valueDate: ev.valueDate, maturity: ev.maturity, cancelled: 0,
      };
      state.trades.set(t.id, t);
      touch(state, tradeKeys(state, t));
      break;
    }
    case 'liquidity': {
      need(RE_CCY.test(ev.ccy), 'BAD_CCY', `bad ccy ${ev.ccy}`);
      need(RE_DATE.test(ev.date), 'BAD_DATE', `bad date ${ev.date}`);
      need(Number.isFinite(ev.amount), 'BAD_AMOUNT', 'liquidity amount must be finite');
      const key = ev.ccy + '|' + ev.date;
      state.liquidity.set(key, r6((state.liquidity.get(key) || 0) + ev.amount));
      touch(state, [key]);
      break;
    }
    case 'cancel': {
      const t = state.trades.get(ev.id);
      need(t, 'NO_TRADE', `unknown trade ${ev.id}`);
      const rem = remaining(t);
      need(rem > 0, 'ALREADY_CANCELLED', `trade ${ev.id} fully cancelled`);
      const portion = ev.amount === undefined ? rem : ev.amount;
      need(Number.isFinite(portion) && portion > 0, 'BAD_AMOUNT', 'cancel amount must be > 0');
      need(portion <= rem + 1e-9, 'BAD_AMOUNT', `cancel amount ${portion} exceeds remaining ${rem}`);
      const p = r6(Math.min(portion, rem));
      // compensation reverses the cancelled portion's legs; both sides unlock.
      const legs = legsOf(t, p).map((l) => ({ ccy: l.ccy, amount: -l.amount }));
      state.compensations.push({ for: t.id, portion: p, legs, atEvent: state.events });
      const before = tradeKeys(state, t);
      t.cancelled = r6(t.cancelled + p);
      touch(state, before);
      break;
    }
    case 'delay': {
      const t = state.trades.get(ev.id);
      need(t, 'NO_TRADE', `unknown trade ${ev.id}`);
      need(RE_DATE.test(ev.valueDate), 'BAD_DATE', `bad valueDate ${ev.valueDate}`);
      const before = tradeKeys(state, t);
      t.valueDate = ev.valueDate;
      touch(state, before.concat(tradeKeys(state, t)));
      break;
    }
    case 'reprice': {
      const t = state.trades.get(ev.id);
      need(t, 'NO_TRADE', `unknown trade ${ev.id}`);
      need(Number.isFinite(ev.rate) && ev.rate > 0, 'BAD_RATE', 'rate must be > 0');
      const before = tradeKeys(state, t);
      t.rate = ev.rate;
      touch(state, before);
      break;
    }
    case 'calendar': {
      need(Number.isInteger(ev.version) && ev.version > state.calendar.version,
        'BAD_VERSION', `calendar version must increase (current ${state.calendar.version})`);
      need(Array.isArray(ev.holidays) && ev.holidays.every((h) => RE_DATE.test(h)),
        'BAD_HOLIDAYS', 'holidays must be date strings');
      // topology change: every queue's membership may move -> invalidate all buckets.
      state.calendar = { version: ev.version, holidays: [...new Set(ev.holidays)].sort() };
      state.cache.clear();
      state.dirty.clear();
      break;
    }
    default:
      throw new EngineError('BAD_TYPE', `unknown event type ${ev.type}`);
  }
  state.head = sha256(state.head + '|' + canon(ev));
  state.events += 1;
  return state;
}

// ---------- value-date queues (pairing) ----------

// Coverage walk of one (ccy|date) bucket, ordered by (maturity, tradeId).
// Receive legs add liquidity when reached; deliver legs consume it.
// Insufficient liquidity is PENDING, never a failure.
function computeBucket(state, key) {
  const legs = [];
  for (const t of state.trades.values()) {
    if (remaining(t) <= 0) continue;
    const date = adjust(t.valueDate, state.calendar);
    for (const leg of legsOf(t)) {
      if (leg.ccy + '|' + date === key) {
        legs.push({ tradeId: t.id, maturity: t.maturity, amount: leg.amount });
      }
    }
  }
  legs.sort((a, b) =>
    a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1
      : a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0);
  let avail = r6(state.liquidity.get(key) || 0);
  const [ccy, date] = key.split('|');
  const coverage = new Map();
  for (const leg of legs) {
    if (leg.amount <= 0) {
      avail = r6(avail - leg.amount);
      coverage.set(leg.tradeId, { covered: true });
    } else if (avail + 1e-9 >= leg.amount) {
      avail = r6(avail - leg.amount);
      coverage.set(leg.tradeId, { covered: true });
    } else {
      coverage.set(leg.tradeId, {
        covered: false,
        reason: { reason: 'INSUFFICIENT_LIQUIDITY', ccy, date, deficit: r6(leg.amount - avail) },
      });
    }
  }
  return coverage;
}

function getCoverage(state, key) {
  let cov = state.cache.get(key);
  if (!cov || state.dirty.has(key)) {
    cov = computeBucket(state, key);
    state.cache.set(key, cov);
    state.dirty.delete(key);
  }
  return cov;
}

// ---------- reports ----------

function activeTrades(state) {
  return [...state.trades.values()]
    .filter((t) => remaining(t) > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function tradeStatus(state, t, fresh) {
  const date = adjust(t.valueDate, state.calendar);
  const keys = tradeKeys(state, t);
  const covs = keys.map((k) => (fresh ? computeBucket(state, k) : getCoverage(state, k)));
  const legs = legsOf(t);
  let reason = null;
  for (let i = 0; i < 2; i++) {
    const c = covs[i].get(t.id);
    if (c && !c.covered && !reason) reason = c.reason;
  }
  const deliverable = covs.every((c) => c.get(t.id) && c.get(t.id).covered);
  return { id: t.id, status: deliverable ? 'DELIVERABLE' : 'PENDING', date, legs, reason };
}

function deliverableReport(state, fresh = false) {
  return {
    type: 'deliverable',
    trades: activeTrades(state).map((t) => tradeStatus(state, t, fresh)),
  };
}

function exposureReport(state, fresh = false) {
  const nets = {};
  const pending = {};
  for (const t of activeTrades(state)) {
    const date = adjust(t.valueDate, state.calendar);
    const nk = t.pair + '@' + date;
    nets[nk] = r6((nets[nk] || 0) + remaining(t));
    const st = tradeStatus(state, t, fresh);
    if (st.status === 'PENDING') {
      for (const leg of st.legs) {
        pending[leg.ccy] = r6((pending[leg.ccy] || 0) + leg.amount);
      }
    }
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { type: 'exposure', nets: sortObj(nets), pending: sortObj(pending) };
}

function snapshot(state) {
  return {
    calendar: state.calendar,
    trades: [...state.trades.values()].map((t) => ({ ...t })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    liquidity: [...state.liquidity.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    compensations: state.compensations,
    events: state.events,
    head: state.head,
  };
}

function proofReport(state) {
  return { type: 'proof', events: state.events, head: state.head, stateHash: sha256(canon(snapshot(state))) };
}

function reports(state, fresh = false) {
  return [deliverableReport(state, fresh), exposureReport(state, fresh), proofReport(state)];
}

module.exports = {
  createState, applyEvent, reports, deliverableReport, exposureReport, proofReport,
  computeBucket, adjust, isBusinessDay, remaining, legsOf, tradeKeys,
  canon, sha256, EngineError, ZERO_HASH,
};
