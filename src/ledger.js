'use strict';

const { createHash } = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function hashEvent(event) {
  const { hash, ...body } = event;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

const DEPS = {
  trade: ['prev'],
  cancel: ['prev', 'tradeHash'],
  restore: ['prev', 'cancelHash'],
};

class LedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LedgerError';
    this.code = code;
  }
}

class Ledger {
  constructor() {
    this.events = new Map();
    this.byId = new Map();
    this._pastCache = new Map();
  }

  static depsOf(event) {
    return DEPS[event.type].map((key) => event[key]).filter((v) => v != null);
  }

  _validate(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new LedgerError('invalid-event');
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new LedgerError('invalid-event');
    }
    if (!Object.hasOwn(DEPS, event.type)) {
      throw new LedgerError('invalid-event');
    }
    if (typeof event.tradeId !== 'string' || event.tradeId.length === 0) {
      throw new LedgerError('invalid-event');
    }
    if (event.prev !== null && typeof event.prev !== 'string') {
      throw new LedgerError('invalid-event');
    }
    if (event.type === 'cancel' && typeof event.tradeHash !== 'string') {
      throw new LedgerError('invalid-event');
    }
    if (event.type === 'restore' && typeof event.cancelHash !== 'string') {
      throw new LedgerError('invalid-event');
    }
  }

  pastOf(event) {
    const out = new Set();
    for (const dep of Ledger.depsOf(event)) {
      out.add(dep);
      for (const h of this.pastHashes(dep)) out.add(h);
    }
    return out;
  }

  pastHashes(hash) {
    let cached = this._pastCache.get(hash);
    if (!cached) {
      const event = this.events.get(hash);
      cached = event ? this.pastOf(event) : new Set();
      this._pastCache.set(hash, cached);
    }
    return cached;
  }

  eventsOfType(type, tradeId) {
    const out = [];
    for (const e of this.events.values()) {
      if (e.type === type && e.tradeId === tradeId) out.push(e);
    }
    return out;
  }

  tradeEvent(tradeId) {
    for (const e of this.events.values()) {
      if (e.type === 'trade' && e.tradeId === tradeId) return e;
    }
    return null;
  }

  addEvent(event) {
    this._validate(event);
    const hash = hashEvent(event);
    if (this.events.has(hash)) return { hash, duplicate: true };
    const known = this.byId.get(event.id);
    if (known !== undefined && known !== hash) {
      throw new LedgerError('duplicate-event-id');
    }
    for (const dep of Ledger.depsOf(event)) {
      if (this.events.has(dep)) continue;
      if (event.type === 'cancel' && dep === event.tradeHash) {
        throw new LedgerError('unknown-trade');
      }
      if (event.type === 'restore' && dep === event.cancelHash) {
        throw new LedgerError('restore-without-cancel');
      }
      throw new LedgerError('missing-dependency');
    }
    const past = this.pastOf(event);
    if (event.type === 'trade') {
      if (this.tradeEvent(event.tradeId)) throw new LedgerError('duplicate-trade');
    } else if (event.type === 'cancel') {
      const target = this.events.get(event.tradeHash);
      if (target.type !== 'trade' || target.tradeId !== event.tradeId) {
        throw new LedgerError('unknown-trade');
      }
      for (const r of this.eventsOfType('restore', event.tradeId)) {
        if (!past.has(r.hash)) throw new LedgerError('conflict');
      }
    } else if (event.type === 'restore') {
      const observed = this.events.get(event.cancelHash);
      if (observed.type !== 'cancel' || observed.tradeId !== event.tradeId) {
        throw new LedgerError('restore-without-cancel');
      }
      const restores = this.eventsOfType('restore', event.tradeId);
      for (const c of this.eventsOfType('cancel', event.tradeId)) {
        if (past.has(c.hash)) continue;
        const cleared = restores.some((r) => this.pastHashes(r.hash).has(c.hash));
        if (!cleared) throw new LedgerError('conflict');
      }
    }
    const stored = { ...event, hash };
    this.events.set(hash, stored);
    this.byId.set(event.id, hash);
    return { hash, duplicate: false };
  }

  tombstone(tradeId) {
    const restores = this.eventsOfType('restore', tradeId);
    const active = [];
    for (const c of this.eventsOfType('cancel', tradeId)) {
      const cleared = restores.some((r) => this.pastHashes(r.hash).has(c.hash));
      if (!cleared) active.push(c.hash);
    }
    active.sort();
    return active.length ? active[0] : null;
  }

  getTrade(tradeId) {
    if (!this.tradeEvent(tradeId)) throw new LedgerError('unknown-trade');
    const tombstone = this.tombstone(tradeId);
    return { tradeId, state: tombstone ? 'cancelled' : 'active', tombstone };
  }

  snapshot() {
    const out = {};
    for (const e of this.events.values()) {
      if (e.type === 'trade') {
        const t = this.getTrade(e.tradeId);
        out[e.tradeId] = { state: t.state, tombstone: t.tombstone };
      }
    }
    return out;
  }

  heads() {
    const referenced = new Set();
    for (const e of this.events.values()) {
      for (const d of Ledger.depsOf(e)) referenced.add(d);
    }
    return [...this.events.keys()].filter((h) => !referenced.has(h)).sort();
  }

  merge(incoming) {
    if (!Array.isArray(incoming)) throw new LedgerError('invalid-event');
    const prepared = incoming.map((e) => {
      this._validate(e);
      const hash = hashEvent(e);
      if (e.hash !== undefined && e.hash !== hash) {
        throw new LedgerError('invalid-event');
      }
      return { ...e, hash };
    });
    const byHash = new Map(prepared.map((e) => [e.hash, e]));
    const depthCache = new Map();
    const depth = (h) => {
      if (depthCache.has(h)) return depthCache.get(h);
      const e = byHash.get(h);
      if (!e) return 0;
      let d = 0;
      for (const dep of Ledger.depsOf(e)) d = Math.max(d, depth(dep) + 1);
      depthCache.set(h, d);
      return d;
    };
    const sorted = [...prepared].sort((a, b) =>
      (depth(a.hash) - depth(b.hash)) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    const clone = this.clone();
    let added = 0;
    let duplicates = 0;
    for (const e of sorted) {
      const { hash, ...body } = e;
      if (clone.addEvent(body).duplicate) duplicates += 1;
      else added += 1;
    }
    this.events = clone.events;
    this.byId = clone.byId;
    this._pastCache = clone._pastCache;
    return { added, duplicates };
  }

  clone() {
    const copy = new Ledger();
    copy.events = new Map(this.events);
    copy.byId = new Map(this.byId);
    copy._pastCache = new Map(this._pastCache);
    return copy;
  }

  toJSON() {
    return { events: [...this.events.values()] };
  }

  static fromJSON(json) {
    const ledger = new Ledger();
    const events = Array.isArray(json) ? json : json.events;
    for (const e of events || []) {
      const { hash, ...body } = e;
      ledger.addEvent(body);
    }
    return ledger;
  }
}

module.exports = { Ledger, LedgerError, hashEvent, canonical };
