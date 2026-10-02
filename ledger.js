'use strict';

const crypto = require('node:crypto');

class LedgerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function eventBody(event) {
  return {
    voucherId: event.voucherId,
    version: event.version,
    amount: event.amount,
    status: event.status,
    prevHash: event.prevHash,
    clock: event.clock,
  };
}

function hashEvent(event) {
  return crypto.createHash('sha256').update(canonical(eventBody(event))).digest('hex');
}

function digestOf(values) {
  return crypto.createHash('sha256').update(values.slice().sort().join('\n')).digest('hex');
}

// clock a dominates-or-equals b, strictly greater in at least one component
function clockAdvances(next, prev) {
  let strictly = false;
  const keys = new Set([...Object.keys(next || {}), ...Object.keys(prev || {})]);
  for (const key of keys) {
    const a = (next && next[key]) || 0;
    const b = (prev && prev[key]) || 0;
    if (a < b) return false;
    if (a > b) strictly = true;
  }
  return strictly;
}

class Ledger {
  constructor(replicaId) {
    if (!replicaId) throw new LedgerError('missing-replica-id');
    this.replicaId = replicaId;
    this.events = new Map(); // hash -> event (event.hash set)
    this.missing = []; // events whose predecessor is unknown
  }

  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const ledger = new Ledger(data.replicaId);
    for (const event of data.events || []) {
      ledger.events.set(event.hash, event);
    }
    ledger.missing = (data.missing || []).slice();
    return ledger;
  }

  toJSON() {
    return {
      replicaId: this.replicaId,
      events: [...this.events.values()],
      missing: this.missing.slice(),
    };
  }

  _voucherEvents(voucherId) {
    return [...this.events.values()].filter((e) => e.voucherId === voucherId);
  }

  headsOf(voucherId) {
    const events = this._voucherEvents(voucherId);
    const hasChild = new Set(events.map((e) => e.prevHash).filter(Boolean));
    return events.filter((e) => !hasChild.has(e.hash));
  }

  frontier() {
    const result = {};
    for (const event of this.events.values()) {
      if (!result[event.voucherId]) result[event.voucherId] = this.headsOf(event.voucherId);
    }
    const out = {};
    for (const [voucherId, heads] of Object.entries(result)) {
      out[voucherId] = heads.map((e) => e.hash).sort();
    }
    return out;
  }

  isAncestor(ancestorHash, hash) {
    let current = this.events.get(hash);
    while (current) {
      if (current.hash === ancestorHash) return true;
      current = current.prevHash ? this.events.get(current.prevHash) : null;
    }
    return false;
  }

  conflicts() {
    const result = {};
    for (const event of this.events.values()) {
      if (result[event.voucherId]) continue;
      const heads = this.headsOf(event.voucherId);
      let conflicted = false;
      for (let i = 0; i < heads.length && !conflicted; i++) {
        for (let j = i + 1; j < heads.length && !conflicted; j++) {
          if (heads[i].amount !== heads[j].amount || heads[i].status !== heads[j].status) {
            conflicted = true;
          }
        }
      }
      if (conflicted) {
        result[event.voucherId] = heads.map((e) => e.hash).sort();
      }
    }
    return result;
  }

  put({ voucherId, amount, status }) {
    if (!voucherId) throw new LedgerError('missing-voucher-id');
    if (this._voucherEvents(voucherId).length > 0) {
      throw new LedgerError('voucher-exists', `voucher ${voucherId} already exists`);
    }
    const event = {
      voucherId,
      version: 1,
      amount,
      status,
      prevHash: null,
      clock: { [this.replicaId]: 1 },
    };
    event.hash = hashEvent(event);
    this.events.set(event.hash, event);
    return event;
  }

  _resolvePredecessor({ voucherId, prevHash, baseVersion }) {
    const events = this._voucherEvents(voucherId);
    if (events.length === 0) throw new LedgerError('unknown-voucher', `voucher ${voucherId} not found`);
    let pred = null;
    if (prevHash != null) {
      pred = this.events.get(prevHash);
      if (!pred || pred.voucherId !== voucherId) {
        throw new LedgerError('unknown-predecessor', `predecessor ${prevHash} not observed`);
      }
    } else if (baseVersion != null) {
      pred = events.find((e) => e.version === baseVersion);
      if (!pred) {
        throw new LedgerError('unknown-predecessor', `version ${baseVersion} of ${voucherId} not observed`);
      }
    } else {
      const heads = this.headsOf(voucherId);
      if (heads.length > 1) {
        throw new LedgerError('conflicted-voucher', `voucher ${voucherId} has multiple heads`);
      }
      pred = heads[0];
    }
    const heads = this.headsOf(voucherId);
    if (!heads.some((h) => h.hash === pred.hash)) {
      throw new LedgerError('stale-clock', `predecessor ${pred.hash} is not the observed head`);
    }
    return pred;
  }

  correct({ voucherId, amount, status, prevHash, baseVersion }) {
    const pred = this._resolvePredecessor({ voucherId, prevHash, baseVersion });
    const clock = { ...pred.clock };
    clock[this.replicaId] = (clock[this.replicaId] || 0) + 1;
    const event = {
      voucherId,
      version: pred.version + 1,
      amount,
      status,
      prevHash: pred.hash,
      clock,
    };
    event.hash = hashEvent(event);
    this.events.set(event.hash, event);
    return event;
  }

  // Apply an event observed from another replica. Throws LedgerError on
  // unknown-predecessor / stale-clock / invalid-hash.
  applyEvent(event) {
    const hash = event.hash;
    if (!hash || hash !== hashEvent(event)) {
      throw new LedgerError('invalid-hash', 'event hash does not match content');
    }
    if (this.events.has(hash)) return { applied: false, duplicate: true, event };
    if (event.prevHash == null) {
      if (event.version !== 1) {
        throw new LedgerError('stale-clock', 'root event must have version 1');
      }
    } else {
      const pred = this.events.get(event.prevHash);
      if (!pred) {
        throw new LedgerError('unknown-predecessor', `predecessor ${event.prevHash} not observed`);
      }
      if (pred.voucherId !== event.voucherId) {
        throw new LedgerError('invalid-predecessor', 'predecessor belongs to another voucher');
      }
      if (event.version !== pred.version + 1) {
        throw new LedgerError('stale-clock', `version ${event.version} does not follow ${pred.version}`);
      }
      if (!clockAdvances(event.clock, pred.clock)) {
        throw new LedgerError('stale-clock', 'vector clock does not advance past predecessor');
      }
    }
    this.events.set(hash, { ...event, hash });
    return { applied: true, duplicate: false, event };
  }

  merge(otherJSON) {
    const other = otherJSON instanceof Ledger ? otherJSON : Ledger.fromJSON(otherJSON);
    // Include our own previously-missing events: this merge may deliver
    // the predecessor they were waiting for.
    const queue = [...other.events.values(), ...other.missing, ...this.missing];
    this.missing = [];
    queue.sort((a, b) => a.version - b.version || (a.hash < b.hash ? -1 : 1));
    const result = { merged: 0, duplicates: 0, missing: 0, rejected: [] };
    let pending = queue;
    // Retry passes: a predecessor may arrive later in the same merge.
    for (;;) {
      const stillMissing = [];
      let progress = false;
      for (const event of pending) {
        try {
          const r = this.applyEvent(event);
          if (r.applied) {
            result.merged += 1;
            progress = true;
          } else {
            result.duplicates += 1;
          }
        } catch (err) {
          if (!(err instanceof LedgerError)) throw err;
          if (err.code === 'unknown-predecessor') {
            stillMissing.push(event);
          } else {
            result.rejected.push({ hash: event.hash, error: err.code });
          }
        }
      }
      pending = stillMissing;
      if (pending.length === 0 || !progress) break;
    }
    for (const event of pending) {
      if (!this.missing.some((m) => m.hash === event.hash)) this.missing.push(event);
    }
    result.missing = this.missing.length;
    return result;
  }

  get(voucherId) {
    const events = this._voucherEvents(voucherId);
    if (events.length === 0) throw new LedgerError('unknown-voucher', `voucher ${voucherId} not found`);
    const heads = this.headsOf(voucherId);
    const conflicts = this.conflicts();
    const summarize = (e) => ({
      hash: e.hash,
      voucherId: e.voucherId,
      version: e.version,
      amount: e.amount,
      status: e.status,
      prevHash: e.prevHash,
      clock: e.clock,
    });
    if (conflicts[voucherId]) {
      return { voucherId, conflict: true, heads: heads.map(summarize) };
    }
    const head = heads.slice().sort((a, b) => (a.hash < b.hash ? -1 : 1))[0];
    return { voucherId, conflict: false, ...summarize(head) };
  }

  audit() {
    const conflicts = this.conflicts();
    const frontier = {};
    const voucherHashes = {};
    const voucherIds = [...new Set([...this.events.values()].map((e) => e.voucherId))].sort();
    for (const voucherId of voucherIds) {
      frontier[voucherId] = this.headsOf(voucherId).map((e) => e.hash).sort();
      voucherHashes[voucherId] = digestOf(this._voucherEvents(voucherId).map((e) => e.hash));
    }
    const conflictCount = Object.keys(conflicts).length;
    const missingCount = this.missing.length;
    return {
      status: conflictCount > 0 || missingCount > 0 ? 'invalid' : 'valid',
      frontier,
      voucherHashes,
      conflicts: conflictCount,
      conflictVouchers: Object.keys(conflicts).sort(),
      missingDependencies: missingCount,
    };
  }
}

module.exports = { Ledger, LedgerError, hashEvent, canonical, clockAdvances };
