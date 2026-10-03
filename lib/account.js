'use strict';

const crypto = require('node:crypto');

const E_RANGE = 'E_RANGE';
const E_LIMIT = 'E_LIMIT';
const E_DUP = 'E_DUP';

const GENESIS = '0'.repeat(64);

function isInt(v) {
  return Number.isSafeInteger(v);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function rangeOf(op) {
  let start = op.start;
  let end = op.end;
  if ((start === undefined || end === undefined) && op.amount && typeof op.amount === 'object') {
    start = op.amount.start;
    end = op.amount.end;
  }
  return [start, end];
}

class Account {
  constructor(config = {}) {
    const { totalLimit, categoryLimits = {} } = config;
    if (!isInt(totalLimit) || totalLimit <= 0) {
      throw new Error(`${E_RANGE}: totalLimit must be a positive integer`);
    }
    for (const [scope, limit] of Object.entries(categoryLimits)) {
      if (!isInt(limit) || limit <= 0) {
        throw new Error(`${E_RANGE}: category limit for "${scope}" must be a positive integer`);
      }
    }
    this.totalLimit = totalLimit;
    this.categoryLimits = { ...categoryLimits };
    this.frozen = []; // sorted, disjoint, non-touching [start, end] intervals
    this.frozenTotal = 0;
    this.debitedTotal = 0;
    this.debitedByScope = {};
    this.seenIds = new Set();
    this.steps = [];
    this.audit = [];
  }

  available() {
    return this.totalLimit - this.frozenTotal - this.debitedTotal;
  }

  static sortOps(ops) {
    return ops
      .map((op, index) => ({ op, index }))
      .sort((a, b) =>
        (a.op.ts - b.op.ts) ||
        (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : a.index - b.index))
      .map((entry) => entry.op);
  }

  _recomputeFrozenTotal() {
    this.frozenTotal = this.frozen.reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  _mergeFreeze(start, end) {
    let s = start;
    let e = end;
    const next = [];
    let placed = false;
    for (const [a, b] of this.frozen) {
      if (b < s) {
        next.push([a, b]);
      } else if (e < a) {
        if (!placed) {
          next.push([s, e]);
          placed = true;
        }
        next.push([a, b]);
      } else {
        s = Math.min(s, a);
        e = Math.max(e, b);
      }
    }
    if (!placed) next.push([s, e]);
    this.frozen = next;
    this._recomputeFrozenTotal();
  }

  _cutFreeze(start, end) {
    let hit = false;
    const next = [];
    for (const [a, b] of this.frozen) {
      if (b <= start || a >= end) {
        next.push([a, b]);
        continue;
      }
      hit = true;
      if (a < start) next.push([a, start]);
      if (end < b) next.push([end, b]);
    }
    if (!hit) return false;
    this.frozen = next;
    this._recomputeFrozenTotal();
    return true;
  }

  _validateRange(op) {
    const [start, end] = rangeOf(op);
    if (!isInt(start) || !isInt(end) || start < 0 || end > this.totalLimit || start >= end) {
      return { error: `invalid range [${String(start)}, ${String(end)}] within [0, ${this.totalLimit}]` };
    }
    return { start, end };
  }

  _freeze(op) {
    const v = this._validateRange(op);
    if (v.error) return { ok: false, reason: E_RANGE, detail: v.error };
    this._mergeFreeze(v.start, v.end);
    return { ok: true };
  }

  _unfreeze(op) {
    const v = this._validateRange(op);
    if (v.error) return { ok: false, reason: E_RANGE, detail: v.error };
    if (!this._cutFreeze(v.start, v.end)) {
      return { ok: false, reason: E_RANGE, detail: `unfreeze range [${v.start}, ${v.end}] does not intersect any freeze` };
    }
    return { ok: true };
  }

  _debit(op) {
    const amount = op.amount;
    const scope = op.scope === undefined ? 'default' : op.scope;
    if (!isInt(amount) || amount <= 0) {
      return { ok: false, reason: E_RANGE, detail: `invalid debit amount ${String(amount)}` };
    }
    if (typeof scope !== 'string' || scope.length === 0) {
      return { ok: false, reason: E_RANGE, detail: 'invalid scope' };
    }
    // Priority: explicit freeze > category limit > total limit.
    if (amount > this.available()) {
      if (amount <= this.totalLimit - this.debitedTotal) {
        return { ok: false, reason: E_RANGE, detail: 'blocked by explicit freeze' };
      }
      return { ok: false, reason: E_LIMIT, detail: 'total limit exceeded' };
    }
    const catLimit = this.categoryLimits[scope];
    if (catLimit !== undefined) {
      const used = this.debitedByScope[scope] || 0;
      if (amount > catLimit - used) {
        return { ok: false, reason: E_LIMIT, detail: `category limit "${scope}" exceeded` };
      }
    }
    this.debitedTotal += amount;
    this.debitedByScope[scope] = (this.debitedByScope[scope] || 0) + amount;
    return { ok: true };
  }

  apply(op) {
    const { ts, id, op: kind } = op;
    let result;
    if (this.seenIds.has(id)) {
      result = { ok: false, reason: E_DUP, detail: `duplicate request id "${id}"` };
    } else {
      this.seenIds.add(id);
      switch (kind) {
        case 'freeze': result = this._freeze(op); break;
        case 'unfreeze': result = this._unfreeze(op); break;
        case 'debit': result = this._debit(op); break;
        default: result = { ok: false, reason: E_RANGE, detail: `unknown op "${String(kind)}"` };
      }
    }
    const ok = result.ok;
    const reason = result.reason || null;
    const detail = result.detail || null;
    const seq = this.steps.length;
    const stateDigest = sha256(JSON.stringify({
      available: this.available(),
      frozen: this.frozen,
      debitedTotal: this.debitedTotal,
      debitedByScope: this.debitedByScope,
    }));
    const prevHash = this.audit.length ? this.audit[this.audit.length - 1].hash : GENESIS;
    const body = { seq, ts, id, op: kind, ok, reason, detail, prevHash, stateDigest };
    const hash = sha256(JSON.stringify(body));
    const step = {
      seq, ts, id, op: kind, ok, reason, detail,
      available: this.available(),
      frozen: this.frozen.map(([s, e]) => [s, e]),
      hash,
    };
    this.steps.push(step);
    this.audit.push({ ...body, hash });
    return step;
  }

  applyAll(ops) {
    for (const op of Account.sortOps(ops)) this.apply(op);
    return this.report();
  }

  report() {
    return {
      config: { totalLimit: this.totalLimit, categoryLimits: { ...this.categoryLimits } },
      steps: this.steps,
      final: {
        available: this.available(),
        frozen: this.frozen.map(([s, e]) => [s, e]),
        frozenTotal: this.frozenTotal,
        debitedTotal: this.debitedTotal,
        debitedByScope: { ...this.debitedByScope },
      },
      audit: this.audit,
    };
  }
}

module.exports = { Account, E_RANGE, E_LIMIT, E_DUP, GENESIS, sha256 };
