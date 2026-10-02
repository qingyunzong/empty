'use strict';

// ---------------------------------------------------------------------------
// Serial reference implementation of the refund risk-control semantics.
// Written independently from src/core.js (scan-based, no event sourcing) so
// the enumeration test can differentially compare the two.
// ---------------------------------------------------------------------------

function runReference(config, requests) {
  const highRisk = new Set(config.highRiskTags);
  const refunds = new Map(); // insertion order == FIFO queue order
  const orders = new Map();
  let budgetUsed = 0;
  let now = 0;
  const results = [];

  const ensureOrder = (id, paid) => {
    if (!orders.has(id)) orders.set(id, { paid: 0, refunded: 0 });
    const o = orders.get(id);
    if (typeof paid === 'number' && paid > o.paid) o.paid = paid;
    return o;
  };
  const remaining = (o) => o.paid - o.refunded;

  function admit() {
    for (const r of refunds.values()) {
      if (r.state === 'PENDING' && r.high && !r.budgetHeld) {
        if (budgetUsed + r.amount <= config.budgetLimit) {
          r.budgetHeld = true;
          budgetUsed += r.amount;
        } else break; // FIFO: head-of-line blocking
      }
    }
  }

  function advance(t) {
    if (typeof t === 'number' && t > now) now = t;
    for (;;) {
      let pick = null;
      for (const r of refunds.values()) {
        if (r.state === 'PENDING' && r.high && !r.budgetHeld && r.expireAt <= now) {
          if (!pick || r.expireAt < pick.expireAt || (r.expireAt === pick.expireAt && r.key < pick.key)) pick = r;
        }
      }
      if (!pick) break;
      pick.state = 'REJECTED';
      pick.code = 'BUDGET_EXHAUSTED';
    }
    admit();
  }

  const resultOf = (r) => {
    const out = { status: 'ok', key: r.key, state: r.state };
    if (r.code) out.code = r.code;
    return out;
  };
  const release = (r) => {
    if (r.budgetHeld) { r.budgetHeld = false; budgetUsed -= r.amount; }
  };

  for (const req of requests) {
    advance(req.t);
    const op = req.op;
    let res;
    if (op.op === 'refund') {
      const existing = refunds.get(op.key);
      if (existing) {
        res = existing.amount !== op.amount
          ? { status: 'conflict', code: 'CONFLICT', key: existing.key, originalAmount: existing.amount, amount: op.amount, state: existing.state }
          : resultOf(existing);
      } else {
        const order = ensureOrder(op.order, op.paid);
        const r = {
          key: op.key, order: op.order, amount: op.amount,
          high: highRisk.has(op.riskTag), riskTag: op.riskTag || null,
          state: 'PENDING', budgetHeld: false, code: null, expireAt: null,
        };
        refunds.set(r.key, r);
        if (r.amount > remaining(order)) {
          r.state = 'REJECTED'; r.code = 'LIMIT_EXCEEDED';
        } else if (r.high) {
          r.expireAt = now + config.slaMs;
          admit();
        }
        res = resultOf(r);
      }
    } else if (op.op === 'approve' || op.op === 'reject' || op.op === 'expire' || op.op === 'reverse') {
      const r = refunds.get(op.key);
      if (!r) {
        res = { status: 'error', code: 'UNKNOWN_KEY', key: op.key };
      } else if (op.op === 'approve') {
        if (r.state !== 'PENDING' || (r.high && !r.budgetHeld)) {
          res = resultOf(r);
        } else if (r.amount > remaining(orders.get(r.order))) {
          release(r); r.state = 'REJECTED'; r.code = 'LIMIT_EXCEEDED';
          res = resultOf(r);
        } else {
          orders.get(r.order).refunded += r.amount;
          r.state = 'APPROVED';
          res = resultOf(r);
        }
      } else if (op.op === 'reject') {
        if (r.state === 'PENDING') { release(r); r.state = 'REJECTED'; r.code = 'INVALID_STATE'; }
        res = resultOf(r);
      } else if (op.op === 'expire') {
        if (r.state === 'PENDING') { release(r); r.state = 'EXPIRED'; }
        res = resultOf(r);
      } else {
        if (r.state === 'APPROVED') {
          orders.get(r.order).refunded -= r.amount;
          release(r);
          r.state = 'REVERSED';
        }
        res = resultOf(r);
      }
      admit();
    } else if (op.op === 'tick') {
      if (typeof op.to === 'number' && op.to >= now) { now = op.to; advance(now); }
      res = { status: 'ok', now };
    } else {
      res = { status: 'error', code: 'UNKNOWN_OP', op: op.op };
    }
    results.push(res);
  }

  const snapshot = { budgetUsed, refunds: {}, orders: {}, queue: [] };
  for (const [k, r] of [...refunds.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    snapshot.refunds[k] = { state: r.state, amount: r.amount, budgetHeld: r.budgetHeld, rejectCode: r.code, riskTag: r.riskTag, order: r.order };
    if (r.state === 'PENDING' && r.high && !r.budgetHeld) snapshot.queue.push(k);
  }
  for (const [id, o] of [...orders.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    snapshot.orders[id] = { paid: o.paid, refunded: o.refunded, remaining: o.paid - o.refunded };
  }
  return { results, snapshot };
}

module.exports = { runReference };
