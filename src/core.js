'use strict';

// ---------------------------------------------------------------------------
// Refund risk-control core: deterministic state machine.
// Pure module: no I/O, no wall clock. All time is virtual (driven by frames).
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['REJECTED', 'EXPIRED', 'REVERSED']);

const REJECT_REASON = {
  LIMIT: 'LIMIT_EXCEEDED',
  BUDGET: 'BUDGET_EXHAUSTED',
  STATE: 'INVALID_STATE',
};

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

class Core {
  constructor(config = {}) {
    this.config = {
      budgetLimit: config.budgetLimit ?? 0,
      slaMs: config.slaMs ?? 0,
      highRiskTags: new Set(config.highRiskTags || []),
    };
    this.orders = new Map(); // orderId -> {paid, refunded}
    this.refunds = new Map(); // key -> record
    this.budgetUsed = 0;
    this.queue = []; // pending high-risk refunds, FIFO
    this.audit = []; // {seq, event, data, hash}
    this.now = 0;
    this._chain = '0'.repeat(64);
    this._sha256 = null; // injected by host (cli) for real hashing
  }

  setHasher(fn) {
    this._sha256 = fn;
  }

  _hash(text) {
    if (this._sha256) return this._sha256(text);
    // FNV-1a fallback (tests inject the real sha256 too, but stay safe)
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  _emit(event, data) {
    const seq = this.audit.length + 1;
    const hash = this._hash(this._chain + '|' + seq + '|' + event + '|' + canonical(data));
    this.audit.push({ seq, event, data, hash });
    this._chain = hash;
  }

  _ensureOrder(orderId, paid) {
    let order = this.orders.get(orderId);
    if (!order) {
      order = { paid: 0, refunded: 0 };
      this.orders.set(orderId, order);
    }
    if (typeof paid === 'number' && paid > order.paid) {
      order.paid = paid;
      this._emit('orderRegistered', { order: orderId, paid });
    }
    return order;
  }

  _remaining(order) {
    return order.paid - order.refunded;
  }

  _scheduleExpiry(record, fromTime) {
    record.expireAt = fromTime + this.config.slaMs;
  }

  _releaseBudget(record) {
    if (record.budgetHeld) {
      record.budgetHeld = false;
      this.budgetUsed -= record.amount;
      this._emit('budgetReleased', { key: record.key, amount: record.amount, budgetUsed: this.budgetUsed });
    }
  }

  _removeFromQueue(record) {
    const idx = this.queue.indexOf(record);
    if (idx >= 0) this.queue.splice(idx, 1);
  }

  _reject(record, reason, code) {
    this._removeFromQueue(record);
    this._releaseBudget(record);
    record.state = record.amount > 0 ? 'REJECTED' : record.state;
    record.state = 'REJECTED';
    record.rejectCode = code;
    record.rejectReason = reason;
    this._emit('refundRejected', { key: record.key, code, reason });
  }

  _expire(record) {
    this._removeFromQueue(record);
    this._releaseBudget(record);
    record.state = 'EXPIRED';
    this._emit('refundExpired', { key: record.key });
  }

  // Process every queued/pending item whose SLA deadline has passed.
  // Ties at the same timestamp are decided by ascending key.
  _processTimeouts(upto) {
    for (;;) {
      const due = this.queue
        .filter((r) => r.expireAt <= upto)
        .sort((a, b) => (a.expireAt - b.expireAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
      if (!due) break;
      this._reject(due, 'budget not granted before SLA deadline', REJECT_REASON.BUDGET);
    }
  }

  // Admit queued refunds while budget allows, in FIFO order.
  _admitQueue() {
    for (;;) {
      const head = this.queue[0];
      if (!head) break;
      if (head.budgetHeld || this.budgetUsed + head.amount > this.config.budgetLimit) break;
      this.queue.shift();
      head.budgetHeld = true;
      this.budgetUsed += head.amount;
      this._emit('budgetReserved', { key: head.key, amount: head.amount, budgetUsed: this.budgetUsed });
    }
  }

  _isHighRisk(record) {
    return this.config.highRiskTags.has(record.riskTag);
  }

  _validate(key, amount) {
    if (typeof key !== 'string' || key.length === 0) return 'key must be a non-empty string';
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return 'amount must be a positive number';
    }
    return null;
  }

  _conflictResult(record, amount) {
    return {
      status: 'conflict',
      code: 'CONFLICT',
      key: record.key,
      originalAmount: record.amount,
      amount,
      state: record.state,
    };
  }

  _resultFor(record) {
    const out = { status: 'ok', key: record.key, state: record.state };
    if (record.rejectCode) out.code = record.rejectCode;
    return out;
  }

  // --- operations ---------------------------------------------------------

  refund(op) {
    const err = this._validate(op.key, op.amount);
    if (err) return { status: 'error', code: 'INVALID', message: err };
    const existing = this.refunds.get(op.key);
    if (existing) {
      if (existing.amount !== op.amount) return this._conflictResult(existing, op.amount);
      return this._resultFor(existing); // idempotent replay of the original decision
    }
    const order = this._ensureOrder(op.order, op.paid);
    const record = {
      key: op.key,
      order: op.order,
      amount: op.amount,
      riskTag: op.riskTag || null,
      state: 'PENDING',
      budgetHeld: false,
      queued: false,
      createdAt: this.now,
      expireAt: null,
      rejectCode: null,
      rejectReason: null,
    };
    this.refunds.set(record.key, record);
    this._emit('refundRequested', {
      key: record.key,
      order: record.order,
      amount: record.amount,
      riskTag: record.riskTag,
    });
    if (record.amount > this._remaining(order)) {
      this._reject(record, 'amount exceeds refundable balance', REJECT_REASON.LIMIT);
      return this._resultFor(record);
    }
    if (this._isHighRisk(record)) {
      this._scheduleExpiry(record, this.now);
      if (this.queue.length === 0 && this.budgetUsed + record.amount <= this.config.budgetLimit) {
        record.budgetHeld = true;
        this.budgetUsed += record.amount;
        this._emit('budgetReserved', { key: record.key, amount: record.amount, budgetUsed: this.budgetUsed });
      } else {
        record.queued = true;
        this.queue.push(record);
        this._emit('refundQueued', { key: record.key, expireAt: record.expireAt });
      }
    }
    return this._resultFor(record);
  }

  approve(op) {
    const record = this.refunds.get(op.key);
    if (!record) return { status: 'error', code: 'UNKNOWN_KEY', key: op.key };
    if (record.state !== 'PENDING') return this._resultFor(record); // late approve: no-op
    if (this._isHighRisk(record) && !record.budgetHeld) {
      // Still waiting for budget; the SLA clock (not this frame) decides its fate.
      return this._resultFor(record);
    }
    const order = this.orders.get(record.order);
    if (record.amount > this._remaining(order)) {
      this._reject(record, 'amount exceeds refundable balance', REJECT_REASON.LIMIT);
      return this._resultFor(record);
    }
    this._removeFromQueue(record);
    order.refunded += record.amount;
    record.state = 'APPROVED';
    this._emit('refundApproved', { key: record.key, order: record.order, amount: record.amount });
    this._admitQueue();
    return this._resultFor(record);
  }

  reject(op) {
    const record = this.refunds.get(op.key);
    if (!record) return { status: 'error', code: 'UNKNOWN_KEY', key: op.key };
    if (record.state !== 'PENDING') return this._resultFor(record);
    this._reject(record, op.reason || 'rejected by risk control', REJECT_REASON.STATE);
    this._admitQueue();
    return this._resultFor(record);
  }

  expire(op) {
    const record = this.refunds.get(op.key);
    if (!record) return { status: 'error', code: 'UNKNOWN_KEY', key: op.key };
    if (record.state !== 'PENDING') return this._resultFor(record); // late expire: no-op
    this._expire(record);
    this._admitQueue();
    return this._resultFor(record);
  }

  reverse(op) {
    const record = this.refunds.get(op.key);
    if (!record) return { status: 'error', code: 'UNKNOWN_KEY', key: op.key };
    if (record.state !== 'APPROVED') return this._resultFor(record); // nothing to undo
    const order = this.orders.get(record.order);
    order.refunded -= record.amount;
    this._releaseBudget(record);
    record.state = 'REVERSED';
    this._emit('reverseRefund', { key: record.key, order: record.order, amount: record.amount });
    this._admitQueue();
    return this._resultFor(record);
  }

  // Advance the virtual clock; fires SLA auto-rejections for queued refunds.
  tick(op) {
    const to = typeof op.to === 'number' ? op.to : this.now;
    if (to < this.now) return { status: 'ok', now: this.now };
    this.now = to;
    this._processTimeouts(to);
    this._admitQueue();
    return { status: 'ok', now: this.now };
  }

  // Ingest one logical op. `t` is the virtual arrival time of the frame.
  apply(op, t) {
    if (typeof t === 'number' && t > this.now) {
      this.now = t;
      this._processTimeouts(t);
      this._admitQueue(); // timed-out queue heads may unblock successors
    }
    switch (op.op) {
      case 'refund': return this.refund(op);
      case 'approve': return this.approve(op);
      case 'reject': return this.reject(op);
      case 'expire': return this.expire(op);
      case 'reverse': return this.reverse(op);
      case 'tick': return this.tick(op);
      default: return { status: 'error', code: 'UNKNOWN_OP', op: op.op };
    }
  }

  // --- introspection ------------------------------------------------------

  auditHash() {
    return this._chain;
  }

  // Recompute the chain from the stored entries; false means tampering.
  verifyAudit() {
    let chain = '0'.repeat(64);
    for (const entry of this.audit) {
      chain = this._hash(chain + '|' + entry.seq + '|' + entry.event + '|' + canonical(entry.data));
      if (chain !== entry.hash) return false;
    }
    return chain === this._chain;
  }

  snapshot() {
    const keys = [...this.refunds.keys()].sort();
    const refunds = {};
    for (const key of keys) {
      const r = this.refunds.get(key);
      refunds[key] = {
        state: r.state,
        order: r.order,
        amount: r.amount,
        riskTag: r.riskTag,
        budgetHeld: r.budgetHeld,
        rejectCode: r.rejectCode,
      };
    }
    const orders = {};
    for (const id of [...this.orders.keys()].sort()) {
      const o = this.orders.get(id);
      orders[id] = { paid: o.paid, refunded: o.refunded, remaining: o.paid - o.refunded };
    }
    return {
      now: this.now,
      budget: {
        limit: this.config.budgetLimit,
        used: this.budgetUsed,
        available: this.config.budgetLimit - this.budgetUsed,
      },
      queue: this.queue.map((r) => r.key),
      refunds,
      orders,
      auditHash: this.auditHash(),
      auditLength: this.audit.length,
    };
  }
}

module.exports = { Core, canonical, REJECT_REASON, TERMINAL };
