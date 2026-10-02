import { BUDGET_LIMIT, WINDOW_MS, SLA_MS, HIGH_RISK_TAGS } from './config.js';

export class CrashFault extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrashFault';
  }
}

export class Engine {
  constructor(wal = null, hooks = {}) {
    this.wal = wal;
    this.hooks = hooks;
    this.clock = 0;
    this.keys = new Map();
    this.orders = new Map();
    this.reservations = new Map();
    this.deductions = [];
    this.queue = [];
    this.pendingDecisions = new Map();
    this.rejections = [];
    this.errors = [];
    if (wal) for (const entry of wal.entries) this.apply(entry);
  }

  log(entry) {
    const stored = this.wal ? this.wal.append(entry) : entry;
    this.apply(stored);
    return stored;
  }

  apply(entry) {
    switch (entry.op) {
      case 'payment':
        this.orders.set(entry.order, { paid: entry.amount, refunded: 0, reserved: 0 });
        break;
      case 'accept': {
        this.keys.set(entry.key, {
          key: entry.key,
          order: entry.order,
          amount: entry.amount,
          riskTag: entry.riskTag,
          state: entry.queued ? 'QUEUED' : 'PENDING',
          requestTs: entry.ts,
          deadline: entry.deadline,
          code: null,
        });
        this.orders.get(entry.order).reserved += entry.amount;
        if (entry.reserved) this.reservations.set(entry.key, entry.amount);
        if (entry.queued) this.queue.push(entry.key);
        break;
      }
      case 'reject_key':
        this.keys.set(entry.key, {
          key: entry.key,
          order: entry.order,
          amount: entry.amount,
          riskTag: entry.riskTag,
          state: 'REJECTED',
          requestTs: entry.ts,
          deadline: entry.ts,
          code: entry.code,
        });
        this.rejections.push({ key: entry.key, code: entry.code, ts: entry.ts });
        break;
      case 'admit': {
        const k = this.keys.get(entry.key);
        k.state = 'PENDING';
        this.reservations.set(entry.key, entry.amount);
        this.queue = this.queue.filter((x) => x !== entry.key);
        break;
      }
      case 'decision': {
        const k = this.keys.get(entry.key);
        const order = this.orders.get(k.order);
        if (entry.decision === 'APPROVED') {
          k.state = 'APPROVED';
          order.reserved -= k.amount;
          order.refunded += k.amount;
          if (this.reservations.has(entry.key)) {
            this.reservations.delete(entry.key);
            this.deductions.push({ key: entry.key, amount: k.amount, ts: entry.ts, released: false });
          }
        } else {
          k.state = entry.decision;
          k.code = entry.code;
          order.reserved -= k.amount;
          this.reservations.delete(entry.key);
          this.queue = this.queue.filter((x) => x !== entry.key);
          this.rejections.push({ key: entry.key, code: entry.code, ts: entry.ts });
        }
        break;
      }
      case 'reverse': {
        const k = this.keys.get(entry.key);
        k.state = 'REVERSED';
        this.orders.get(k.order).refunded -= k.amount;
        const d = this.deductions.find((x) => x.key === entry.key && !x.released);
        if (d) d.released = true;
        break;
      }
      case 'pending':
        this.pendingDecisions.set(entry.key, { decision: entry.decision, ts: entry.ts });
        break;
      default:
        throw new Error(`unknown wal op: ${entry.op}`);
    }
  }

  budgetUsed(now) {
    let used = 0;
    for (const amount of this.reservations.values()) used += amount;
    for (const d of this.deductions) {
      if (!d.released && now - d.ts < WINDOW_MS) used += d.amount;
    }
    return used;
  }

  advance(now) {
    for (const k of [...this.keys.values()]) {
      if ((k.state === 'PENDING' || k.state === 'QUEUED') && k.deadline <= now) {
        this.log({ op: 'decision', key: k.key, decision: 'EXPIRED', code: 'SLA_EXPIRED', ts: now });
      }
    }
    this.admitQueue(now);
  }

  admitQueue(now) {
    if (this.queue.length === 0) return;
    const sorted = [...this.queue].sort((a, b) => {
      const ka = this.keys.get(a);
      const kb = this.keys.get(b);
      return ka.requestTs - kb.requestTs || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const key of sorted) {
      const k = this.keys.get(key);
      if (this.budgetUsed(now) + k.amount <= BUDGET_LIMIT) {
        this.log({ op: 'admit', key, amount: k.amount, ts: now });
      }
    }
  }

  process(frame) {
    this.hooks.beforeDecision?.(frame);
    const now = Math.max(this.clock, frame.ts ?? 0);
    this.clock = now;
    this.advance(now);
    let resp;
    switch (frame.type) {
      case 'payment': resp = this.doPayment(frame); break;
      case 'refund': resp = this.doRefund(frame, now); break;
      case 'approve': resp = this.doDecision(frame, now, 'APPROVED'); break;
      case 'reject': resp = this.doDecision(frame, now, 'REJECTED'); break;
      case 'expire': resp = this.doDecision(frame, now, 'EXPIRED'); break;
      case 'reverse': resp = this.doReverse(frame, now); break;
      default: resp = { status: 'error', code: 'UNKNOWN_TYPE' };
    }
    this.advance(this.clock);
    this.hooks.afterLog?.(frame);
    this.hooks.beforeResponse?.(frame);
    return resp;
  }

  doPayment(f) {
    const existing = this.orders.get(f.order);
    if (existing) {
      if (existing.paid === f.amount) return { status: 'duplicate', order: f.order };
      this.errors.push({ type: 'conflict', order: f.order, expected: existing.paid, got: f.amount });
      return { status: 'error', code: 'CONFLICT', order: f.order };
    }
    this.log({ op: 'payment', order: f.order, amount: f.amount, ts: f.ts ?? 0 });
    return { status: 'ok', order: f.order };
  }

  doRefund(f, now) {
    const existing = this.keys.get(f.key);
    if (existing) {
      if (existing.amount === f.amount && existing.order === f.order) {
        return { status: 'duplicate', key: f.key, result: this.resultOf(f.key) };
      }
      this.errors.push({ type: 'conflict', key: f.key, expected: existing.amount, got: f.amount });
      return { status: 'error', code: 'CONFLICT', key: f.key };
    }
    const order = this.orders.get(f.order);
    if (!order) {
      this.errors.push({ type: 'over_limit', key: f.key, code: 'UNKNOWN_ORDER' });
      this.log({ op: 'reject_key', key: f.key, order: f.order, amount: f.amount, riskTag: f.riskTag, code: 'UNKNOWN_ORDER', ts: now });
      return { status: 'rejected', code: 'UNKNOWN_ORDER', key: f.key };
    }
    const refundable = order.paid - order.refunded - order.reserved;
    if (f.amount > refundable) {
      this.errors.push({ type: 'over_limit', key: f.key, code: 'OVER_LIMIT' });
      this.log({ op: 'reject_key', key: f.key, order: f.order, amount: f.amount, riskTag: f.riskTag, code: 'OVER_LIMIT', ts: now });
      return { status: 'rejected', code: 'OVER_LIMIT', key: f.key };
    }
    const high = HIGH_RISK_TAGS.has(f.riskTag);
    const deadline = now + SLA_MS;
    let queued = false;
    let reserved = false;
    if (high) {
      if (this.budgetUsed(now) + f.amount <= BUDGET_LIMIT) reserved = true;
      else queued = true;
    }
    this.log({ op: 'accept', key: f.key, order: f.order, amount: f.amount, riskTag: f.riskTag, ts: now, deadline, queued, reserved });
    const resp = { status: 'accepted', key: f.key, state: queued ? 'QUEUED' : 'PENDING', deadline };
    const pending = this.pendingDecisions.get(f.key);
    if (pending) {
      this.pendingDecisions.delete(f.key);
      resp.decision = this.applyDecision(f.key, pending.decision, now, null);
    }
    return resp;
  }

  doDecision(f, now, decision) {
    const k = this.keys.get(f.key);
    if (!k) {
      this.log({ op: 'pending', key: f.key, decision, ts: now });
      return { status: 'pending', key: f.key, decision };
    }
    return this.applyDecision(f.key, decision, now, f.reason ?? null);
  }

  applyDecision(key, decision, now, reason) {
    const k = this.keys.get(key);
    if (decision === 'APPROVED') {
      if (k.state === 'PENDING') {
        this.log({ op: 'decision', key, decision: 'APPROVED', ts: now });
        return { status: 'ok', key, state: 'APPROVED' };
      }
      if (k.state === 'QUEUED') {
        if (this.budgetUsed(now) + k.amount <= BUDGET_LIMIT) {
          this.log({ op: 'admit', key, amount: k.amount, ts: now });
          this.log({ op: 'decision', key, decision: 'APPROVED', ts: now });
          return { status: 'ok', key, state: 'APPROVED' };
        }
        return { status: 'queued', key, code: 'BUDGET_EXCEEDED' };
      }
      if (k.state === 'APPROVED') return { status: 'duplicate', key, result: { state: 'APPROVED' } };
      return { status: 'late', key, code: `ALREADY_${k.state}` };
    }
    const code = decision === 'REJECTED' ? (reason || 'MANUAL_REJECT') : (reason || 'EXPIRED');
    if (k.state === 'PENDING' || k.state === 'QUEUED') {
      this.log({ op: 'decision', key, decision, code, ts: now });
      return { status: 'ok', key, state: decision, code };
    }
    if (k.state === decision) return { status: 'duplicate', key, result: { state: decision, code: k.code } };
    return { status: 'late', key, code: `ALREADY_${k.state}` };
  }

  doReverse(f, now) {
    const k = this.keys.get(f.key);
    if (!k) return { status: 'error', code: 'UNKNOWN_KEY', key: f.key };
    if (k.state === 'REVERSED') return { status: 'duplicate', key: f.key, result: { state: 'REVERSED' } };
    if (k.state !== 'APPROVED') return { status: 'error', code: 'NOT_APPROVED', key: f.key };
    const reverseId = `reverseRefund:${f.key}`;
    this.log({ op: 'reverse', key: f.key, reverseId, ts: now });
    return { status: 'ok', key: f.key, state: 'REVERSED', reverseId };
  }

  resultOf(key) {
    const k = this.keys.get(key);
    const result = { state: k.state };
    if (k.code) result.code = k.code;
    return result;
  }

  report() {
    const keys = {};
    for (const [name, k] of [...this.keys.entries()].sort()) {
      keys[name] = { state: k.state, order: k.order, amount: k.amount, riskTag: k.riskTag };
      if (k.code) keys[name].code = k.code;
    }
    const orders = {};
    for (const [name, o] of [...this.orders.entries()].sort()) {
      orders[name] = {
        paid: o.paid,
        refunded: o.refunded,
        reserved: o.reserved,
        refundable: o.paid - o.refunded - o.reserved,
      };
    }
    let reserved = 0;
    for (const amount of this.reservations.values()) reserved += amount;
    let deducted = 0;
    for (const d of this.deductions) {
      if (!d.released && this.clock - d.ts < WINDOW_MS) deducted += d.amount;
    }
    return {
      keys,
      orders,
      budget: { limit: BUDGET_LIMIT, windowMs: WINDOW_MS, used: reserved + deducted, reserved, deducted },
      rejections: this.rejections,
      errors: this.errors,
      auditHash: this.wal ? this.wal.hash : null,
      clock: this.clock,
    };
  }
}
