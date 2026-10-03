'use strict';
const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashEvent(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

class LedgerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function clockLeq(a, b) {
  for (const k of Object.keys(a)) if ((b[k] || 0) < a[k]) return false;
  return true;
}

function clockEq(a, b) {
  return clockLeq(a, b) && clockLeq(b, a);
}

// a happens-before b under vector clocks
function happensBefore(a, b) {
  return clockLeq(a.clock, b.clock) && !clockEq(a.clock, b.clock);
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new LedgerError('invalid-event', 'event must be an object');
  }
  const { replica, type, paymentId, amount, clock, preds, hash } = event;
  if (typeof replica !== 'string' || replica.length === 0) throw new LedgerError('invalid-event', 'replica');
  if (type !== 'settle' && type !== 'adjust') throw new LedgerError('invalid-event', 'type');
  if (typeof paymentId !== 'string' || paymentId.length === 0) throw new LedgerError('invalid-event', 'paymentId');
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new LedgerError('invalid-event', 'amount');
  if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) throw new LedgerError('invalid-event', 'clock');
  for (const [k, v] of Object.entries(clock)) {
    if (typeof k !== 'string' || !Number.isInteger(v) || v < 0) throw new LedgerError('invalid-event', 'clock entry');
  }
  if (!Array.isArray(preds) || preds.some((p) => typeof p !== 'string')) throw new LedgerError('invalid-event', 'preds');
  if (typeof hash !== 'string' || hash.length === 0) throw new LedgerError('invalid-event', 'hash');
}

function eventBody(event) {
  return {
    replica: event.replica,
    type: event.type,
    paymentId: event.paymentId,
    amount: event.amount,
    clock: event.clock,
    preds: event.preds,
  };
}

class Ledger {
  constructor(events) {
    this.events = new Map(); // hash -> event, insertion ordered
    if (events) for (const e of events) this.addEvent(e);
  }

  static createEvent({ replica, type, paymentId, amount }, ledger) {
    const preds = ledger ? ledger.frontier() : [];
    const clock = {};
    if (ledger) {
      for (const e of ledger.events.values()) {
        for (const [k, v] of Object.entries(e.clock)) {
          clock[k] = Math.max(clock[k] || 0, v);
        }
      }
    }
    clock[replica] = (clock[replica] || 0) + 1;
    const body = { replica, type, paymentId, amount, clock, preds };
    return { ...body, hash: hashEvent(body) };
  }

  addEvent(event) {
    validateEvent(event);
    if (hashEvent(eventBody(event)) !== event.hash) {
      throw new LedgerError('bad-hash', 'event hash does not match content');
    }
    if (this.events.has(event.hash)) return 'duplicate';
    for (const p of event.preds) {
      if (!this.events.has(p)) {
        throw new LedgerError('unknown-predecessor', 'missing predecessor ' + p);
      }
    }
    // clock must dominate every predecessor's clock (no rollback)
    for (const p of event.preds) {
      const pe = this.events.get(p);
      if (!clockLeq(pe.clock, event.clock)) {
        throw new LedgerError('stale-clock', 'event clock regresses below a predecessor');
      }
    }
    // per-origin sequence must strictly advance over what we already know
    const seq = event.clock[event.replica] || 0;
    for (const e of this.events.values()) {
      if (e.replica === event.replica && (e.clock[e.replica] || 0) >= seq) {
        throw new LedgerError('stale-clock', 'event clock regresses for origin ' + event.replica);
      }
    }
    this.events.set(event.hash, event);
    return 'added';
  }

  frontier() {
    const referenced = new Set();
    for (const e of this.events.values()) for (const p of e.preds) referenced.add(p);
    return [...this.events.keys()].filter((h) => !referenced.has(h)).sort();
  }

  analyze() {
    const byPayment = new Map();
    for (const e of this.events.values()) {
      if (!byPayment.has(e.paymentId)) byPayment.set(e.paymentId, []);
      byPayment.get(e.paymentId).push(e);
    }
    const balances = {};
    const conflicts = [];
    for (const [paymentId, list] of byPayment) {
      let conflict = false;
      for (let i = 0; i < list.length && !conflict; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.amount !== b.amount && !happensBefore(a, b) && !happensBefore(b, a)) {
            conflict = true;
            break;
          }
        }
      }
      if (conflict) {
        conflicts.push(paymentId);
        continue;
      }
      const maximals = list.filter((a) => !list.some((b) => happensBefore(a, b)));
      balances[paymentId] = maximals[0].amount;
    }
    return { balances, conflicts: conflicts.sort() };
  }

  certificate() {
    const { balances, conflicts } = this.analyze();
    if (conflicts.length > 0) {
      throw new LedgerError('conflict', 'conflicting payments: ' + conflicts.join(','));
    }
    const entriesHash = crypto
      .createHash('sha256')
      .update(canonical([...this.events.keys()].sort()))
      .digest('hex');
    return { frontier: this.frontier(), entriesHash, balances };
  }

  toJSON() {
    return { events: [...this.events.values()] };
  }
}

module.exports = { Ledger, LedgerError, canonical, hashEvent, happensBefore, clockLeq, clockEq };
