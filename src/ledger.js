import { splitAmount, COMPONENT_KEYS } from './split.js';

export class RefundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RefundError('VALIDATION_ERROR', `${field} must be a non-empty string`);
  }
  return value;
}

function requireInt(value, field, min) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RefundError('VALIDATION_ERROR', `${field} must be an integer >= ${min}`);
  }
  return value;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function zeroSplit() {
  return { merchant: 0, commission: 0, tax: 0 };
}

// Append-only event-sourced ledger. State is rebuilt by replaying events,
// so re-applying a history file can never produce duplicate postings.
export class Ledger {
  constructor() {
    this.payments = new Map();
    this.refunds = new Map();
    this.events = [];
  }

  static replay(events) {
    const ledger = new Ledger();
    for (const event of events) {
      ledger.apply(event);
    }
    return ledger;
  }

  apply(event) {
    switch (event.type) {
      case 'payment': {
        this.payments.set(event.paymentId, {
          paymentId: event.paymentId,
          components: {
            merchant: event.merchant,
            commission: event.commission,
            tax: event.tax,
          },
          total: event.total,
        });
        break;
      }
      case 'freeze': {
        const record = {
          refundId: event.refundId,
          paymentId: event.paymentId,
          amount: event.amount,
          split: { ...event.split },
          status: 'FROZEN',
          firstResult: null,
          registerResult: null,
          cancelResult: null,
        };
        record.firstResult = {
          ok: true,
          op: 'refund',
          refundId: record.refundId,
          paymentId: record.paymentId,
          amount: record.amount,
          split: { ...record.split },
          status: 'FROZEN',
        };
        this.refunds.set(record.refundId, record);
        break;
      }
      case 'post': {
        const record = this.refunds.get(event.refundId);
        record.status = 'POSTED';
        record.registerResult = {
          ok: true,
          op: 'register',
          refundId: record.refundId,
          status: 'POSTED',
          entries: copy(event.entries),
        };
        break;
      }
      case 'release': {
        const record = this.refunds.get(event.refundId);
        record.status = 'RELEASED';
        record.cancelResult = {
          ok: true,
          op: 'cancel',
          refundId: record.refundId,
          status: 'RELEASED',
        };
        break;
      }
      case 'compensate': {
        const record = this.refunds.get(event.refundId);
        record.status = 'COMPENSATED';
        record.cancelResult = {
          ok: true,
          op: 'cancel',
          refundId: record.refundId,
          status: 'COMPENSATED',
          entries: copy(event.entries),
        };
        break;
      }
      default:
        throw new RefundError('UNKNOWN_EVENT', `unknown event type: ${event.type}`);
    }
    this.events.push(event);
  }

  addPayment(input) {
    const paymentId = requireId(input.paymentId, 'paymentId');
    const merchant = requireInt(input.merchant, 'merchant', 0);
    const commission = requireInt(input.commission, 'commission', 0);
    const tax = requireInt(input.tax, 'tax', 0);
    const total = merchant + commission + tax;
    if (total <= 0) {
      throw new RefundError('VALIDATION_ERROR', 'payment total must be positive');
    }
    const result = {
      ok: true,
      op: 'payment',
      paymentId,
      components: { merchant, commission, tax },
      total,
    };
    const existing = this.payments.get(paymentId);
    if (existing) {
      const same = existing.components.merchant === merchant
        && existing.components.commission === commission
        && existing.components.tax === tax;
      if (!same) {
        throw new RefundError('PAYMENT_EXISTS', `payment already exists with different components: ${paymentId}`);
      }
      return { result, event: null };
    }
    const event = { type: 'payment', paymentId, merchant, commission, tax, total };
    this.apply(event);
    return { result, event };
  }

  requestRefund(input) {
    const refundId = requireId(input.refundId, 'refundId');
    const existing = this.refunds.get(refundId);
    if (existing) {
      // Idempotent: a repeated refundId always returns the first result and
      // never appends another event.
      return { result: copy(existing.firstResult), event: null };
    }
    const paymentId = requireId(input.paymentId, 'paymentId');
    const amount = requireInt(input.amount, 'amount', 1);
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new RefundError('PAYMENT_NOT_FOUND', `payment not found: ${paymentId}`);
    }
    const active = this.activeRefundTotal(paymentId);
    if (active + amount > payment.total) {
      throw new RefundError(
        'REFUND_EXCEEDED',
        `refund amount ${amount} exceeds remaining refundable ${payment.total - active} for payment ${paymentId}`,
      );
    }
    const split = splitAmount(amount, payment.components);
    const event = { type: 'freeze', refundId, paymentId, amount, split };
    this.apply(event);
    return { result: copy(this.refunds.get(refundId).firstResult), event };
  }

  registerRefund(input) {
    const refundId = requireId(input.refundId, 'refundId');
    const record = this.refunds.get(refundId);
    if (!record) {
      throw new RefundError('REFUND_NOT_FOUND', `refund not found: ${refundId}`);
    }
    if (record.status === 'POSTED') {
      return { result: copy(record.registerResult), event: null };
    }
    if (record.status !== 'FROZEN') {
      throw new RefundError('INVALID_STATE', `cannot register refund ${refundId} in status ${record.status}`);
    }
    const entries = COMPONENT_KEYS.map((key) => ({
      account: key,
      direction: 'debit',
      amount: record.split[key],
    }));
    const event = { type: 'post', refundId, paymentId: record.paymentId, entries };
    this.apply(event);
    return { result: copy(record.registerResult), event };
  }

  cancelRefund(input) {
    const refundId = requireId(input.refundId, 'refundId');
    const record = this.refunds.get(refundId);
    if (!record) {
      throw new RefundError('REFUND_NOT_FOUND', `refund not found: ${refundId}`);
    }
    if (record.status === 'RELEASED' || record.status === 'COMPENSATED') {
      return { result: copy(record.cancelResult), event: null };
    }
    let event;
    if (record.status === 'FROZEN') {
      // Cancel before registration: only release the freeze.
      event = { type: 'release', refundId, paymentId: record.paymentId, released: { ...record.split } };
    } else {
      // Cancel after registration: compensate the posted reverse entries.
      const entries = COMPONENT_KEYS.map((key) => ({
        account: key,
        direction: 'credit',
        amount: record.split[key],
      }));
      event = { type: 'compensate', refundId, paymentId: record.paymentId, entries };
    }
    this.apply(event);
    return { result: copy(record.cancelResult), event };
  }

  activeRefundTotal(paymentId) {
    let total = 0;
    for (const record of this.refunds.values()) {
      if (record.paymentId === paymentId && (record.status === 'FROZEN' || record.status === 'POSTED')) {
        total += record.amount;
      }
    }
    return total;
  }

  snapshot() {
    const payments = [...this.payments.values()].map((payment) => {
      const frozen = zeroSplit();
      const posted = zeroSplit();
      for (const record of this.refunds.values()) {
        if (record.paymentId !== payment.paymentId) continue;
        const target = record.status === 'FROZEN' ? frozen : record.status === 'POSTED' ? posted : null;
        if (target) {
          for (const key of COMPONENT_KEYS) target[key] += record.split[key];
        }
      }
      const frozenTotal = COMPONENT_KEYS.reduce((sum, key) => sum + frozen[key], 0);
      const postedTotal = COMPONENT_KEYS.reduce((sum, key) => sum + posted[key], 0);
      return {
        paymentId: payment.paymentId,
        components: { ...payment.components },
        total: payment.total,
        frozen,
        posted,
        frozenTotal,
        postedTotal,
        remaining: payment.total - frozenTotal - postedTotal,
      };
    });
    const refunds = [...this.refunds.values()].map((record) => ({
      refundId: record.refundId,
      paymentId: record.paymentId,
      amount: record.amount,
      split: { ...record.split },
      status: record.status,
    }));
    return { payments, refunds };
  }
}
