'use strict';

const { E } = require('./errors');
const { nextState, TERMINAL } = require('./state-machine');

// Demo conversion rates to the base currency (USD). Currencies absent from
// this table are "unknown": never converted, kept in their own bucket.
const BASE_CURRENCY = 'USD';
const KNOWN_RATES = { USD: 1, EUR: 1.08, GBP: 1.27, CNY: 0.14 };
const NULL_CURRENCY_BUCKET = 'UNKNOWN';

function emptyBucket() {
  return { count: 0, sum: 0, min: null, max: null, tipSum: 0, tipCount: 0 };
}

function emptyAggregate() {
  return { buckets: new Map(), converted: { currency: BASE_CURRENCY, count: 0, sum: 0 } };
}

// Add one captured amount into a bucket. NULL amount/tip are ignored by the
// numeric aggregates (min/max/sum) but the capture itself is still counted.
function bucketAdd(bucket, amount, tip) {
  bucket.count += 1;
  if (amount !== null && amount !== undefined) {
    bucket.sum += amount;
    bucket.min = bucket.min === null ? amount : Math.min(bucket.min, amount);
    bucket.max = bucket.max === null ? amount : Math.max(bucket.max, amount);
  }
  if (tip !== null && tip !== undefined) {
    bucket.tipSum += tip;
    bucket.tipCount += 1;
  }
}

function statsKey(merchant, day) {
  return `${merchant}${day}`;
}

class Ledger {
  constructor() {
    this.txns = new Map();          // id -> txn record
    this.log = [];                  // applied events, in order
    this.stats = new Map();         // `${merchant} ${day}` -> aggregate (materialized, incremental)
    this.lockedThrough = new Map(); // merchant -> most recent settled day (inclusive lock boundary)
  }

  apply(event) {
    const txn = this._apply(event);
    this.log.push(event);
    return txn;
  }

  _apply(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw E.validation('event must be an object');
    }
    const { type } = event;
    switch (type) {
      case 'auth': return this._auth(event);
      case 'capture': return this._transition(event, 'capture');
      case 'void': return this._transition(event, 'void');
      case 'refund': return this._transition(event, 'refund');
      case 'reverse': return this._reverseRefund(event);
      case 'chargeback': return this._transition(event, 'chargeback');
      case 'reverse_chargeback': return this._reverseChargeback(event);
      case 'settle': return this._settle(event);
      default: throw E.validation(`unknown event type: ${String(type)}`);
    }
  }

  _auth(event) {
    const { id, merchant, day } = event;
    for (const field of ['id', 'merchant', 'day']) {
      if (typeof event[field] !== 'string' || event[field] === '') {
        throw E.validation(`auth: "${field}" must be a non-empty string`);
      }
    }
    if (this.txns.has(id)) throw E.duplicate(id);
    for (const num of ['amount', 'tip']) {
      if (event[num] !== undefined && event[num] !== null && typeof event[num] !== 'number') {
        throw E.validation(`auth: "${num}" must be a number or null`);
      }
    }
    if (event.currency !== undefined && event.currency !== null && typeof event.currency !== 'string') {
      throw E.validation('auth: "currency" must be a string or null');
    }
    const txn = {
      id, merchant, authDay: day,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      tip: event.tip ?? null,
      state: 'auth',
      captureDay: null,
      reverseCount: 0,
    };
    this.txns.set(id, txn);
    return txn;
  }

  _getTxn(event) {
    if (typeof event.id !== 'string') throw E.validation(`"${event.type}": "id" must be a string`);
    const txn = this.txns.get(event.id);
    if (!txn) throw E.notFound(event.id);
    return txn;
  }

  _transition(event, op) {
    const txn = this._getTxn(event);
    const next = nextState(txn.state, op);
    if (next === null) throw E.transition(txn.id, txn.state, op);
    txn.state = next;
    if (op === 'capture') {
      txn.captureDay = typeof event.day === 'string' ? event.day : txn.authDay;
      this._addStats(txn);
    }
    return txn;
  }

  _reverseRefund(event) {
    const txn = this._getTxn(event);
    // A refund may be reversed at most once per transaction.
    if (txn.state !== 'refunded' || txn.reverseCount >= 1) {
      throw E.transition(txn.id, txn.state, 'reverse');
    }
    txn.reverseCount += 1;
    txn.state = 'captured';
    return txn;
  }

  _reverseChargeback(event) {
    const txn = this._getTxn(event);
    if (txn.state !== 'charged_back') throw E.transition(txn.id, txn.state, 'reverse_chargeback');
    // Settlement lock: captures on or before the merchant's settled-through
    // day are locked and their chargebacks cannot be reversed.
    const through = this.lockedThrough.get(txn.merchant);
    if (through !== undefined && txn.captureDay <= through) {
      throw E.locked(txn.id, txn.captureDay, through);
    }
    txn.state = 'captured';
    return txn;
  }

  _settle(event) {
    const { merchant, day } = event;
    if (typeof merchant !== 'string' || merchant === '') throw E.validation('settle: "merchant" required');
    if (typeof day !== 'string' || day === '') throw E.validation('settle: "day" required');
    const prev = this.lockedThrough.get(merchant);
    if (prev === undefined || day > prev) this.lockedThrough.set(merchant, day);
    return { merchant, lockedThrough: this.lockedThrough.get(merchant) };
  }

  _addStats(txn) {
    const key = statsKey(txn.merchant, txn.captureDay);
    let agg = this.stats.get(key);
    if (!agg) {
      agg = emptyAggregate();
      this.stats.set(key, agg);
    }
    Ledger._accumulate(agg, txn);
  }

  static _accumulate(agg, txn) {
    const currency = txn.currency ?? NULL_CURRENCY_BUCKET;
    let bucket = agg.buckets.get(currency);
    if (!bucket) {
      bucket = emptyBucket();
      agg.buckets.set(currency, bucket);
    }
    bucketAdd(bucket, txn.amount, txn.tip);
    // Unknown currencies are never converted into the base bucket.
    const rate = KNOWN_RATES[currency];
    if (rate !== undefined && txn.amount !== null) {
      agg.converted.count += 1;
      agg.converted.sum += txn.amount * rate;
    }
  }

  // Materialized, incrementally maintained stats for one merchant/day.
  merchantStats(merchant, day) {
    const agg = this.stats.get(statsKey(merchant, day)) ?? emptyAggregate();
    return Ledger._serialize(merchant, day, agg);
  }

  // Brute-force rescan of the event log (reference implementation).
  bruteForceStats(merchant, day) {
    const agg = emptyAggregate();
    for (const event of this.log) {
      if (event.type !== 'capture') continue;
      const txn = this.txns.get(event.id);
      if (!txn || txn.merchant !== merchant) continue;
      const captureDay = typeof event.day === 'string' ? event.day : txn.authDay;
      if (captureDay !== day) continue;
      Ledger._accumulate(agg, txn);
    }
    return Ledger._serialize(merchant, day, agg);
  }

  // Recompute one merchant/day bucket from the log and replace the
  // materialized value (daily backtracking / repair).
  recomputeDay(merchant, day) {
    const agg = emptyAggregate();
    for (const event of this.log) {
      if (event.type !== 'capture') continue;
      const txn = this.txns.get(event.id);
      if (!txn || txn.merchant !== merchant) continue;
      const captureDay = typeof event.day === 'string' ? event.day : txn.authDay;
      if (captureDay !== day) continue;
      Ledger._accumulate(agg, txn);
    }
    this.stats.set(statsKey(merchant, day), agg);
    return Ledger._serialize(merchant, day, agg);
  }

  // Roll the ledger back to the end of `day` (inclusive) and rebuild by
  // replaying. Events after the cut are dropped, and so are their causal
  // dependents (e.g. a refund whose capture fell beyond the cut).
  rollbackTo(day) {
    const fresh = new Ledger();
    const tainted = new Set();
    let kept = 0;
    for (const event of this.log) {
      const id = typeof event.id === 'string' ? event.id : null;
      if (id && tainted.has(id)) continue;
      if (Ledger._eventDay(event, this.txns) > day) {
        if (id) tainted.add(id);
        continue;
      }
      try {
        fresh.apply(event);
      } catch (err) {
        if (err.code === 'E_TRANSITION' || err.code === 'E_LOCKED') {
          if (id) tainted.add(id);
          continue;
        }
        throw err;
      }
      kept += 1;
    }
    this.txns = fresh.txns;
    this.log = fresh.log;
    this.stats = fresh.stats;
    this.lockedThrough = fresh.lockedThrough;
    return kept;
  }

  static _eventDay(event, txns) {
    if (typeof event.day === 'string') return event.day;
    const txn = event.id ? txns.get(event.id) : null;
    return txn ? txn.authDay : '0000-00-00';
  }

  static _serialize(merchant, day, agg) {
    const buckets = {};
    for (const [currency, b] of [...agg.buckets.entries()].sort()) {
      buckets[currency] = { ...b };
    }
    return {
      merchant,
      day,
      baseCurrency: BASE_CURRENCY,
      converted: { ...agg.converted },
      buckets,
    };
  }
}

module.exports = { Ledger, KNOWN_RATES, BASE_CURRENCY, NULL_CURRENCY_BUCKET, TERMINAL };
