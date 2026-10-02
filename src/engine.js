'use strict';

class XborderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XborderError';
    this.code = code;
  }
}

function sumRecord(rec) {
  let total = 0;
  for (const key of Object.keys(rec)) total += rec[key];
  return total;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Engine {
  constructor() {
    this.account = { budget: 0, quoteTtl: Infinity, worstRate: {}, frozen: {} };
    this.payments = new Map();
    this.eligible = new Set();
    this.now = 0;
  }

  confirmedExposure() {
    let total = sumRecord(this.account.frozen);
    for (const payment of this.payments.values()) {
      if (payment.status === 'frozen') total += payment.amount * payment.rate;
    }
    return total;
  }

  pendingWorstCase() {
    let total = 0;
    for (const payment of this.payments.values()) {
      if (payment.status === 'frozen' || payment.rate !== null) continue;
      const cap = this.account.worstRate[payment.ccy];
      total += payment.amount * (cap === undefined ? Infinity : cap);
    }
    return total;
  }

  isFresh(payment, ts) {
    return ts - payment.quoteTs <= this.account.quoteTtl;
  }

  fitsBudget(payment) {
    const used = this.confirmedExposure() + this.pendingWorstCase();
    return used + payment.amount * payment.rate <= this.account.budget;
  }

  evaluate() {
    const next = new Set();
    for (const payment of this.payments.values()) {
      if (payment.status === 'frozen' || payment.rate === null) continue;
      if (!this.isFresh(payment, this.now)) continue;
      if (!this.fitsBudget(payment)) continue;
      next.add(payment.id);
    }
    return next;
  }

  diff(next) {
    const add = [];
    const remove = [];
    for (const id of next) if (!this.eligible.has(id)) add.push(id);
    for (const id of this.eligible) if (!next.has(id)) remove.push(id);
    this.eligible = next;
    add.sort();
    remove.sort();
    return { add, remove };
  }

  apply(event) {
    if (!isObject(event) || typeof event.type !== 'string') {
      throw new XborderError('E_INVALID', 'event must be an object with a string "type"');
    }
    if (typeof event.ts === 'number' && event.ts > this.now) this.now = event.ts;
    switch (event.type) {
      case 'account':
        this.applyAccount(event);
        break;
      case 'payment':
        this.applyPayment(event);
        break;
      case 'quote':
        this.applyQuote(event);
        break;
      case 'freeze':
        this.applyFreeze(event);
        break;
      case 'reverse':
        this.applyReverse(event);
        break;
      default:
        throw new XborderError('E_INVALID', `unknown event type: ${event.type}`);
    }
    return this.diff(this.evaluate());
  }

  applyAccount(event) {
    if (event.budget !== undefined) {
      if (typeof event.budget !== 'number' || event.budget < 0) {
        throw new XborderError('E_INVALID', 'account.budget must be a non-negative number');
      }
      this.account.budget = event.budget;
    }
    if (event.quoteTtl !== undefined) {
      if (typeof event.quoteTtl !== 'number' || event.quoteTtl < 0) {
        throw new XborderError('E_INVALID', 'account.quoteTtl must be a non-negative number');
      }
      this.account.quoteTtl = event.quoteTtl;
    }
    for (const [field, target] of [['worstRate', this.account.worstRate], ['frozen', this.account.frozen]]) {
      if (event[field] !== undefined) {
        if (!isObject(event[field])) {
          throw new XborderError('E_INVALID', `account.${field} must be an object keyed by currency`);
        }
        for (const [ccy, value] of Object.entries(event[field])) {
          if (typeof value !== 'number' || value < 0) {
            throw new XborderError('E_INVALID', `account.${field}.${ccy} must be a non-negative number`);
          }
          target[ccy] = value;
        }
      }
    }
  }

  applyPayment(event) {
    if (typeof event.id !== 'string' || event.id === '') {
      throw new XborderError('E_INVALID', 'payment.id must be a non-empty string');
    }
    if (this.payments.has(event.id)) {
      throw new XborderError('E_INVALID', `duplicate payment id: ${event.id}`);
    }
    if (typeof event.amount !== 'number' || !(event.amount > 0)) {
      throw new XborderError('E_INVALID', `payment ${event.id}: amount must be a positive number`);
    }
    if (typeof event.ccy !== 'string' || event.ccy === '') {
      throw new XborderError('E_INVALID', `payment ${event.id}: ccy must be a non-empty string`);
    }
    if (event.rate !== null && typeof event.rate !== 'number') {
      throw new XborderError('E_INVALID', `payment ${event.id}: rate must be a number or null`);
    }
    if (typeof event.rate === 'number' && !(event.rate > 0)) {
      throw new XborderError('E_INVALID', `payment ${event.id}: rate must be positive`);
    }
    const rate = event.rate === undefined ? null : event.rate;
    this.payments.set(event.id, {
      id: event.id,
      amount: event.amount,
      ccy: event.ccy,
      rate,
      quoteTs: rate === null ? null : (typeof event.ts === 'number' ? event.ts : this.now),
      status: 'active',
    });
  }

  applyQuote(event) {
    const payment = this.getPayment(event.paymentId);
    if (payment.status === 'frozen') {
      throw new XborderError('E_INVALID', `payment ${payment.id} is frozen; cannot re-quote`);
    }
    if (typeof event.rate !== 'number' || !(event.rate > 0)) {
      throw new XborderError('E_INVALID', `quote for ${payment.id}: rate must be a positive number`);
    }
    const ts = typeof event.ts === 'number' ? event.ts : this.now;
    if (payment.quoteTs !== null && ts < payment.quoteTs) {
      throw new XborderError(
        'E_RATE_STALE',
        `quote for ${payment.id} at ts=${ts} is older than current quote ts=${payment.quoteTs}`
      );
    }
    payment.rate = event.rate;
    payment.quoteTs = ts;
  }

  applyFreeze(event) {
    const payment = this.getPayment(event.paymentId);
    if (payment.status === 'frozen') {
      throw new XborderError('E_INVALID', `payment ${payment.id} is already frozen`);
    }
    if (payment.rate === null) {
      throw new XborderError('E_INVALID', `payment ${payment.id} has no rate yet (pending quote)`);
    }
    if (!this.isFresh(payment, this.now)) {
      throw new XborderError(
        'E_RATE_STALE',
        `quote for ${payment.id} is stale at ts=${this.now} (quoteTs=${payment.quoteTs}, ttl=${this.account.quoteTtl})`
      );
    }
    if (!this.fitsBudget(payment)) {
      const used = this.confirmedExposure() + this.pendingWorstCase();
      throw new XborderError(
        'E_BUDGET',
        `freezing ${payment.id} would exceed budget: used=${used} + exposure=${payment.amount * payment.rate} > budget=${this.account.budget}`
      );
    }
    payment.status = 'frozen';
  }

  applyReverse(event) {
    const payment = this.getPayment(event.paymentId);
    if (payment.status !== 'frozen') {
      throw new XborderError('E_INVALID', `payment ${payment.id} is not frozen; cannot reverse`);
    }
    payment.status = 'active';
  }

  getPayment(id) {
    if (typeof id !== 'string' || !this.payments.has(id)) {
      throw new XborderError('E_INVALID', `unknown payment id: ${id}`);
    }
    return this.payments.get(id);
  }
}

module.exports = { Engine, XborderError };
