import { apportion } from './apportion.js';
import { isValidDate, addDays, compareDates, periodKey, todayStr } from './dates.js';

const ok = (record) => ({ ok: true, record });
const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

const byLineId = (a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);

/**
 * RefundLedger keeps orders, refunds, merchant budgets and loyalty-point
 * effects in memory. All money is integer cents; tax rates are basis points.
 *
 * Dependency model: refunds on the same order share the order-level discount
 * pool and points ledger, so a later refund depends on every earlier active
 * refund of that order. Revoking a refund rolls back its whole descendant
 * subtree (children first); if any node cannot be rolled back the entire
 * subtree is left untouched and E_ROLLBACK_PATH is returned.
 */
export class RefundLedger {
  constructor({ asOf } = {}) {
    this.asOf = asOf ?? todayStr();
    if (!isValidDate(this.asOf)) throw new Error(`invalid as-of date: ${this.asOf}`);
    this.orders = new Map(); // orderId -> order state
    this.refunds = new Map(); // refId -> refund node
    this.budgets = new Map(); // merchantId -> { limit, period }
    this.usageMap = new Map(); // `${merchantId}|${periodKey}` -> cents used
    this.records = []; // emitted output records, in op order
    this.seq = 0;
    this.revCounter = 0;
  }

  setBudget(merchantId, { limit, period = 'monthly' } = {}) {
    if (!merchantId || !Number.isInteger(limit) || limit < 0) {
      return fail('E_INVALID_OP', 'budget requires merchantId and non-negative integer limit');
    }
    this.budgets.set(merchantId, { limit, period });
    return ok({ type: 'budget', merchantId, limit, period });
  }

  #registerOrder(order) {
    let st = this.orders.get(order.orderId);
    if (!st) {
      const discount = order.discount ?? 0;
      const shares = apportion(
        discount,
        order.lines.map((l) => ({ lineId: l.lineId, amount: l.amount }))
      );
      st = {
        order: { ...order, discount },
        shares, // lineId -> discount share (cents), stable apportionment
        consumedDiscount: 0, // discount clawed back by active refunds
        clawedPoints: 0, // loyalty points clawed back by active refunds
        refundedLines: new Set(), // lines covered by active refunds
      };
      this.orders.set(order.orderId, st);
      if (order.budget) this.setBudget(order.merchantId, order.budget);
    }
    return st;
  }

  #isSettled(node) {
    return compareDates(this.asOf, addDays(node.date, node.settleDays)) >= 0;
  }

  #usageKey(merchantId, date) {
    const budget = this.budgets.get(merchantId);
    return `${merchantId}|${periodKey(date, budget?.period ?? 'monthly')}`;
  }

  /** Current budget usage (cents) for the merchant's period containing `date`. */
  usage(merchantId, date) {
    return this.usageMap.get(this.#usageKey(merchantId, date)) ?? 0;
  }

  orderState(orderId) {
    return this.orders.get(orderId);
  }

  refund(refId, order, lineIds, { date, settleDays = 1 } = {}) {
    date = date ?? this.asOf;
    if (!isValidDate(date)) return fail('E_INVALID_DATE', `invalid refund date: ${date}`);
    if (!Number.isInteger(settleDays) || settleDays < 0) {
      return fail('E_INVALID_OP', 'settleDays must be a non-negative integer');
    }
    if (this.refunds.has(refId)) return fail('E_DUPLICATE_REF', `refund ${refId} already exists`);
    if (!order || !order.orderId) return fail('E_INVALID_OP', 'order.orderId is required');
    const known = this.orders.get(order.orderId);
    if (!known && !Array.isArray(order.lines)) {
      return fail('E_INVALID_OP', 'order.lines is required for a new order');
    }
    const st = this.#registerOrder(order);
    const ord = st.order;

    const ids = lineIds ?? ord.lines.map((l) => l.lineId);
    if (!Array.isArray(ids) || ids.length === 0) return fail('E_INVALID_OP', 'no lines to refund');
    if (new Set(ids).size !== ids.length) return fail('E_INVALID_OP', 'duplicate line ids');

    const lineMap = new Map(ord.lines.map((l) => [l.lineId, l]));
    for (const id of ids) {
      if (!lineMap.has(id)) return fail('E_UNKNOWN_LINES', `unknown line ${id}`);
      if (st.refundedLines.has(id)) {
        return fail('E_LINE_ALREADY_REFUNDED', `line ${id} already covered by an active refund`);
      }
    }

    // Per-line effects: discount share clawback, tax on the discounted net,
    // loyalty points clawback. Sorted by lineId for stable output.
    const details = ids
      .map((id) => {
        const line = lineMap.get(id);
        const share = st.shares.get(id) ?? 0;
        const net = line.amount - share;
        const tax = Math.round((net * (line.taxRateBps ?? 0)) / 10000);
        const points = line.points ?? 0;
        return { lineId: id, amount: line.amount, discountShare: share, net, tax, points, total: net + tax };
      })
      .sort(byLineId);

    const sum = (k) => details.reduce((s, d) => s + d[k], 0);
    const total = sum('total');
    const tax = sum('tax');
    const discountReversal = sum('discountShare');
    const pointsReversal = sum('points');

    // Budget: all-or-nothing. Reject before mutating anything.
    const budget = this.budgets.get(ord.merchantId);
    const key = this.#usageKey(ord.merchantId, date);
    const used = this.usageMap.get(key) ?? 0;
    if (budget && used + total > budget.limit) {
      return fail('E_BUDGET_EXCEEDED', `refund of ${total}c exceeds budget: used ${used}c of ${budget.limit}c`, {
        used,
        limit: budget.limit,
      });
    }

    for (const d of details) st.refundedLines.add(d.lineId);
    st.consumedDiscount += discountReversal;
    st.clawedPoints += pointsReversal;
    if (budget) this.usageMap.set(key, used + total);

    const node = {
      refId,
      orderId: ord.orderId,
      merchantId: ord.merchantId,
      lines: details,
      total,
      tax,
      discountReversal,
      pointsReversal,
      date,
      settleDays,
      status: 'active', // active | revoked | reversed
      seq: this.seq++,
    };
    this.refunds.set(refId, node);

    const record = {
      type: 'refund',
      refId,
      orderId: node.orderId,
      merchantId: node.merchantId,
      status: this.#isSettled(node) ? 'settled' : 'pending',
      lines: details,
      amount: total - tax,
      tax,
      discountReversal,
      pointsReversal,
      total,
      date,
    };
    this.records.push(record);
    return ok(record);
  }

  revoke(refId, { reverse = false } = {}) {
    const node = this.refunds.get(refId);
    if (!node) return fail('E_NOT_FOUND', `unknown refund ${refId}`);
    if (node.status === 'revoked') return fail('E_ALREADY_REVOKED', `refund ${refId} already revoked`);
    if (node.status === 'reversed') return fail('E_ALREADY_REVERSED', `refund ${refId} already reversed`);

    if (this.#isSettled(node)) {
      if (!reverse) {
        return fail('E_ALREADY_SETTLED', `refund ${refId} is settled; pass reverse to issue a reversal`);
      }
      // Settled refunds can no longer be revoked; emit an optional reverse
      // (counter) refund that negates the original money flow.
      this.revCounter += 1;
      const reversalId = `${refId}-rev${this.revCounter}`;
      node.status = 'reversed';
      const key = this.#usageKey(node.merchantId, node.date);
      this.usageMap.set(key, (this.usageMap.get(key) ?? 0) - node.total);
      const reversal = {
        type: 'reversal',
        refId: reversalId,
        parentRefId: refId,
        orderId: node.orderId,
        merchantId: node.merchantId,
        amount: -(node.total - node.tax),
        tax: -node.tax,
        discountReversal: -node.discountReversal,
        pointsReversal: -node.pointsReversal,
        total: -node.total,
        date: this.asOf,
      };
      this.records.push(reversal);
      return {
        ok: false,
        error: { code: 'E_ALREADY_SETTLED', message: `refund ${refId} already settled; reversal ${reversalId} issued` },
        reversal,
      };
    }

    // Rollback subtree: this refund plus every later active refund on the
    // same order (they were computed on top of this one's effects).
    const subtree = [
      ...[...this.refunds.values()]
        .filter((x) => x.orderId === node.orderId && x.seq > node.seq && x.status === 'active')
        .sort((a, b) => b.seq - a.seq), // children first
      node,
    ];

    // Validation pass: nothing mutates unless the whole subtree can roll back.
    for (const n of subtree) {
      if (this.#isSettled(n)) {
        return fail('E_ROLLBACK_PATH', `cannot roll back ${refId}: descendant refund ${n.refId} is already settled`, {
          path: [refId, n.refId],
        });
      }
    }

    // Apply pass: restore discount apportionment, tax and points per node.
    const st = this.orders.get(node.orderId);
    const rolledBack = [];
    let restoredDiscount = 0;
    let restoredPoints = 0;
    let restoredTotal = 0;
    for (const n of subtree) {
      n.status = 'revoked';
      for (const d of n.lines) st.refundedLines.delete(d.lineId);
      st.consumedDiscount -= n.discountReversal;
      st.clawedPoints -= n.pointsReversal;
      restoredDiscount += n.discountReversal;
      restoredPoints += n.pointsReversal;
      restoredTotal += n.total;
      const key = this.#usageKey(n.merchantId, n.date);
      this.usageMap.set(key, (this.usageMap.get(key) ?? 0) - n.total);
      rolledBack.push(n.refId);
    }

    const record = {
      type: 'revoke',
      refId,
      orderId: node.orderId,
      rolledBack,
      restoredDiscount,
      restoredPoints,
      restoredTotal,
    };
    this.records.push(record);
    return ok(record);
  }
}
