import { allocate } from './allocation.js';
import { RefundError } from './errors.js';

const MICRO = 1_000_000;
const toMicro = (rate) => Math.round(Number(rate) * MICRO);

export const taxOf = (amount, rate) => Math.round((amount * toMicro(rate)) / MICRO);
export const pointsOf = (amount, rate) => Math.floor((amount * toMicro(rate)) / MICRO);

const budgetKey = (merchantId, period) => `${merchantId}|${period}`;
const periodOf = (date) => String(date).slice(0, 7);

export class Ledger {
  constructor() {
    this.orders = new Map(); // orderId -> { order, refunded: Map(lineId -> amount) }
    this.refunds = new Map(); // refId -> refund node
    this.budgets = new Map(); // `${merchantId}|${period}` -> { limit, used }
    this.reversals = []; // reverse flows generated from settled revokes
    this.seq = 0;
  }

  addOrder(order) {
    if (!order || !order.orderId || !order.merchantId || !Array.isArray(order.lines) || order.lines.length === 0) {
      throw new RefundError('E_VALIDATION', 'order requires orderId, merchantId and non-empty lines');
    }
    const seen = new Set();
    for (const l of order.lines) {
      if (!l.lineId || !Number.isInteger(l.amount) || l.amount < 0) {
        throw new RefundError('E_VALIDATION', `invalid line ${JSON.stringify(l)}`);
      }
      if (seen.has(l.lineId)) throw new RefundError('E_VALIDATION', `duplicate lineId ${l.lineId}`);
      seen.add(l.lineId);
    }
    if (this.orders.has(order.orderId)) {
      throw new RefundError('E_VALIDATION', `order ${order.orderId} already registered`);
    }
    const normalized = {
      orderId: order.orderId,
      merchantId: order.merchantId,
      discount: order.discount ?? 0,
      pointsRate: order.pointsRate ?? 0,
      lines: order.lines.map((l) => ({ lineId: l.lineId, amount: l.amount, taxRate: l.taxRate ?? 0 })),
    };
    this.orders.set(order.orderId, { order: normalized, refunded: new Map(normalized.lines.map((l) => [l.lineId, 0])) });
    return normalized;
  }

  setBudget(merchantId, period, limit) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RefundError('E_VALIDATION', `budget limit must be a non-negative integer, got ${limit}`);
    }
    const key = budgetKey(merchantId, period);
    const used = this.budgets.get(key)?.used ?? 0;
    this.budgets.set(key, { merchantId, period, limit, used });
    return this.budgets.get(key);
  }

  getBudget(merchantId, period) {
    return this.budgets.get(budgetKey(merchantId, period)) ?? null;
  }

  // Pure derived view: discount allocation, tax and points are fully
  // recomputed from (order, refunded) so any state restore is a full rollback.
  computeWith(orderId, refunded) {
    const st = this.orders.get(orderId);
    if (!st) throw new RefundError('E_NOT_FOUND', `unknown order ${orderId}`);
    const { order } = st;
    const effective = order.lines.map((l) => ({ lineId: l.lineId, amount: l.amount - (refunded.get(l.lineId) ?? 0) }));
    const discountAlloc = allocate(order.discount, effective);
    const lines = new Map();
    const totals = { effective: 0, discount: 0, net: 0, tax: 0, points: 0, gross: 0 };
    for (const l of order.lines) {
      const eff = l.amount - (refunded.get(l.lineId) ?? 0);
      const discount = discountAlloc.get(l.lineId) ?? 0;
      const net = eff - discount;
      const tax = taxOf(net, l.taxRate);
      const points = pointsOf(net, order.pointsRate);
      lines.set(l.lineId, { lineId: l.lineId, effective: eff, discount, net, tax, points });
      totals.effective += eff;
      totals.discount += discount;
      totals.net += net;
      totals.tax += tax;
      totals.points += points;
      totals.gross += net + tax;
    }
    return { orderId, lines, totals };
  }

  computeOrder(orderId) {
    const st = this.orders.get(orderId);
    if (!st) throw new RefundError('E_NOT_FOUND', `unknown order ${orderId}`);
    return this.computeWith(orderId, st.refunded);
  }

  refund(refId, orderId, lines, { date = '1970-01-01' } = {}) {
    if (this.refunds.has(refId)) throw new RefundError('E_DUPLICATE_REF', `refId ${refId} already exists`);
    const st = this.orders.get(orderId);
    if (!st) throw new RefundError('E_NOT_FOUND', `unknown order ${orderId}`);
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new RefundError('E_VALIDATION', 'refund requires a non-empty lines array');
    }
    const before = this.computeWith(orderId, st.refunded);
    const trial = new Map(st.refunded);
    for (const l of lines) {
      const orderLine = st.order.lines.find((x) => x.lineId === l.lineId);
      if (!orderLine) throw new RefundError('E_VALIDATION', `unknown lineId ${l.lineId} on order ${orderId}`);
      if (!Number.isInteger(l.amount) || l.amount <= 0) {
        throw new RefundError('E_VALIDATION', `refund amount for ${l.lineId} must be a positive integer`);
      }
      const next = (trial.get(l.lineId) ?? 0) + l.amount;
      if (next > orderLine.amount) {
        throw new RefundError('E_INVALID_REFUND', `refund of ${l.amount} on ${l.lineId} exceeds remaining ${orderLine.amount - (trial.get(l.lineId) ?? 0)}`);
      }
      trial.set(l.lineId, next);
    }
    const after = this.computeWith(orderId, trial);
    const gross = before.totals.gross - after.totals.gross;
    const period = periodOf(date);
    const budget = this.budgets.get(budgetKey(st.order.merchantId, period));
    if (budget && budget.used + gross > budget.limit) {
      // All-or-nothing: reject before any mutation, no partial deduction.
      throw new RefundError('E_BUDGET_EXCEEDED', `refund gross ${gross} exceeds budget for ${st.order.merchantId} in ${period} (used ${budget.used}, limit ${budget.limit})`, {
        limit: budget.limit, used: budget.used, requested: gross,
      });
    }
    const effects = lines.map((l) => {
      const b = before.lines.get(l.lineId);
      const a = after.lines.get(l.lineId);
      return { lineId: l.lineId, amount: l.amount, discount: a.discount - b.discount, tax: a.tax - b.tax, points: a.points - b.points };
    });
    // Commit only after every check passed.
    st.refunded = trial;
    if (budget) budget.used += gross;
    const node = {
      refId, orderId, merchantId: st.order.merchantId, lines: lines.map((l) => ({ ...l })),
      period, gross, effects, status: 'pending', date, seq: ++this.seq,
    };
    this.refunds.set(refId, node);
    return node;
  }

  settle(refId) {
    const node = this.refunds.get(refId);
    if (!node) throw new RefundError('E_NOT_FOUND', `unknown refund ${refId}`);
    if (node.status !== 'pending') throw new RefundError('E_INVALID_STATE', `refund ${refId} is ${node.status}, cannot settle`);
    node.status = 'settled';
    return node;
  }

  // Refunds on the same order form a chain by creation order: later refunds
  // were computed on top of earlier ones, so revoking a node requires rolling
  // back its whole descendant subtree. Any failing child (e.g. settled)
  // aborts the entire revoke with E_ROLLBACK_PATH and leaves state untouched.
  revoke(refId, { reverse = false } = {}) {
    const node = this.refunds.get(refId);
    if (!node) throw new RefundError('E_NOT_FOUND', `unknown refund ${refId}`);
    if (node.status === 'revoked') throw new RefundError('E_ALREADY_REVOKED', `refund ${refId} already revoked`);
    if (node.status === 'settled') {
      if (reverse) {
        const reversal = {
          revId: `${refId}:rev`, of: refId, orderId: node.orderId, merchantId: node.merchantId,
          gross: -node.gross, effects: node.effects.map((e) => ({ ...e, discount: -e.discount, tax: -e.tax, points: -e.points })),
          status: 'settled', seq: ++this.seq,
        };
        this.reversals.push(reversal);
        throw new RefundError('E_ALREADY_SETTLED', `refund ${refId} already settled; reverse flow ${reversal.revId} generated`, { reversal });
      }
      throw new RefundError('E_ALREADY_SETTLED', `refund ${refId} already settled; pass { reverse: true } to emit a reverse flow`);
    }
    const descendants = [...this.refunds.values()]
      .filter((n) => n.orderId === node.orderId && n.seq > node.seq && n.status !== 'revoked')
      .sort((a, b) => a.seq - b.seq);
    const subtree = [node, ...descendants];
    const blocker = subtree.find((n) => n.status !== 'pending');
    if (blocker) {
      throw new RefundError('E_ROLLBACK_PATH', `rollback of ${refId} blocked at ${blocker.refId} (${blocker.status}); subtree left unchanged`, {
        path: subtree.map((n) => n.refId), blockedBy: blocker.refId,
      });
    }
    const st = this.orders.get(node.orderId);
    const trial = new Map(st.refunded);
    for (const n of subtree) {
      for (const l of n.lines) trial.set(l.lineId, (trial.get(l.lineId) ?? 0) - l.amount);
    }
    for (const [lineId, v] of trial) {
      if (v < 0) {
        throw new RefundError('E_ROLLBACK_PATH', `rollback of ${refId} would drive line ${lineId} negative; subtree left unchanged`, {
          path: subtree.map((n) => n.refId), blockedBy: lineId,
        });
      }
    }
    // Commit: every child succeeded, so the whole subtree rolls back at once.
    st.refunded = trial;
    for (const n of subtree) {
      n.status = 'revoked';
      const budget = this.budgets.get(budgetKey(n.merchantId, n.period));
      if (budget) budget.used -= n.gross;
    }
    return { revoked: subtree.map((n) => n.refId) };
  }
}
