export const COMPONENTS = ['merchant', 'commission', 'tax'];

export class RefundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
  }
}

function zeroSplit() {
  return { merchant: 0, commission: 0, tax: 0 };
}

function addSplit(a, b) {
  return {
    merchant: a.merchant + b.merchant,
    commission: a.commission + b.commission,
    tax: a.tax + b.tax,
  };
}

function subSplit(a, b) {
  return {
    merchant: a.merchant - b.merchant,
    commission: a.commission - b.commission,
    tax: a.tax - b.tax,
  };
}

function sumSplit(s) {
  return s.merchant + s.commission + s.tax;
}

function assertSplit(shape, what) {
  for (const key of COMPONENTS) {
    if (!Number.isInteger(shape[key]) || shape[key] < 0) {
      throw new RefundError('INVALID_INPUT', `${what}.${key} must be a non-negative integer`);
    }
  }
}

/**
 * Split `amount` across the three components proportionally to their
 * original shares, distributing the rounding remainder with the largest
 * remainder method (ties broken in fixed component order).
 */
export function splitAmount(amount, components) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RefundError('INVALID_AMOUNT', 'amount must be a non-negative integer');
  }
  const total = sumSplit(components);
  if (total <= 0) {
    if (amount === 0) return zeroSplit();
    throw new RefundError('INVALID_INPUT', 'component total must be positive');
  }
  const result = zeroSplit();
  const rows = COMPONENTS.map((key) => {
    const product = amount * components[key];
    const base = Math.floor(product / total);
    result[key] = base;
    return { key, remainder: product - base * total };
  });
  let leftover = amount - sumSplit(result);
  rows.sort(
    (a, b) => b.remainder - a.remainder || COMPONENTS.indexOf(a.key) - COMPONENTS.indexOf(b.key),
  );
  for (const row of rows) {
    if (leftover === 0) break;
    result[row.key] += 1;
    leftover -= 1;
  }
  return result;
}

export class RefundService {
  constructor({ appendEvent } = {}) {
    this.payments = new Map();
    this.refunds = new Map();
    this.appendEvent = typeof appendEvent === 'function' ? appendEvent : () => {};
  }

  static fromEvents(events, options = {}) {
    const service = new RefundService(options);
    for (const event of events) service._apply(event);
    return service;
  }

  _emit(event) {
    this._apply(event);
    this.appendEvent(event);
  }

  _apply(event) {
    switch (event.type) {
      case 'payment_settled': {
        this.payments.set(event.paymentId, {
          paymentId: event.paymentId,
          components: {
            merchant: event.merchant,
            commission: event.commission,
            tax: event.tax,
          },
          ledger: { frozen: zeroSplit(), posted: zeroSplit(), compensated: zeroSplit() },
        });
        break;
      }
      case 'refund_frozen': {
        const payment = this.payments.get(event.paymentId);
        payment.ledger.frozen = addSplit(payment.ledger.frozen, event.split);
        const record = {
          refundId: event.refundId,
          paymentId: event.paymentId,
          amount: event.amount,
          split: { ...event.split },
          status: 'frozen',
          result: {
            refundId: event.refundId,
            paymentId: event.paymentId,
            amount: event.amount,
            split: { ...event.split },
            status: 'frozen',
          },
        };
        this.refunds.set(event.refundId, record);
        break;
      }
      case 'refund_posted': {
        const record = this.refunds.get(event.refundId);
        const payment = this.payments.get(record.paymentId);
        payment.ledger.frozen = subSplit(payment.ledger.frozen, record.split);
        payment.ledger.posted = addSplit(payment.ledger.posted, record.split);
        record.status = 'posted';
        break;
      }
      case 'refund_released': {
        const record = this.refunds.get(event.refundId);
        const payment = this.payments.get(record.paymentId);
        payment.ledger.frozen = subSplit(payment.ledger.frozen, record.split);
        record.status = 'released';
        break;
      }
      case 'refund_compensated': {
        const record = this.refunds.get(event.refundId);
        const payment = this.payments.get(record.paymentId);
        payment.ledger.compensated = addSplit(payment.ledger.compensated, record.split);
        record.status = 'compensated';
        break;
      }
      default:
        throw new RefundError('INVALID_EVENT', `unknown event type: ${event.type}`);
    }
  }

  _effectiveRefunded(payment) {
    const { frozen, posted, compensated } = payment.ledger;
    return sumSplit(frozen) + sumSplit(posted) - sumSplit(compensated);
  }

  settlePayment({ paymentId, merchant, commission, tax } = {}) {
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new RefundError('INVALID_INPUT', 'paymentId must be a non-empty string');
    }
    const components = { merchant, commission, tax };
    assertSplit(components, 'payment');
    if (sumSplit(components) <= 0) {
      throw new RefundError('INVALID_INPUT', 'payment total must be positive');
    }
    if (this.payments.has(paymentId)) {
      throw new RefundError('DUPLICATE_PAYMENT', `payment already settled: ${paymentId}`);
    }
    this._emit({ type: 'payment_settled', paymentId, merchant, commission, tax });
    return { paymentId, components, total: sumSplit(components) };
  }

  requestRefund({ refundId, paymentId, amount } = {}) {
    if (typeof refundId !== 'string' || refundId.length === 0) {
      throw new RefundError('INVALID_INPUT', 'refundId must be a non-empty string');
    }
    const existing = this.refunds.get(refundId);
    if (existing) {
      return structuredClone(existing.result);
    }
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new RefundError('INVALID_INPUT', 'paymentId must be a non-empty string');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RefundError('INVALID_AMOUNT', 'amount must be a positive integer');
    }
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new RefundError('PAYMENT_NOT_FOUND', `payment not found: ${paymentId}`);
    }
    const total = sumSplit(payment.components);
    const cumulativeBefore = this._effectiveRefunded(payment);
    const cumulativeAfter = cumulativeBefore + amount;
    if (cumulativeAfter > total) {
      throw new RefundError(
        'REFUND_EXCEEDED',
        `cumulative refund ${cumulativeAfter} exceeds payment total ${total} for ${paymentId}`,
      );
    }
    const split = subSplit(
      splitAmount(cumulativeAfter, payment.components),
      splitAmount(cumulativeBefore, payment.components),
    );
    this._emit({ type: 'refund_frozen', refundId, paymentId, amount, split });
    return structuredClone(this.refunds.get(refundId).result);
  }

  registerRefund(refundId) {
    const record = this._getRefund(refundId);
    if (record.status !== 'frozen') {
      throw new RefundError(
        'INVALID_STATE',
        `refund ${refundId} is ${record.status}; only frozen refunds can be registered`,
      );
    }
    this._emit({ type: 'refund_posted', refundId });
    return this._refundView(record);
  }

  cancelRefund(refundId) {
    const record = this._getRefund(refundId);
    if (record.status === 'frozen') {
      this._emit({ type: 'refund_released', refundId });
    } else if (record.status === 'posted') {
      this._emit({ type: 'refund_compensated', refundId });
    } else {
      throw new RefundError(
        'INVALID_STATE',
        `refund ${refundId} is ${record.status}; it cannot be cancelled`,
      );
    }
    return this._refundView(record);
  }

  _getRefund(refundId) {
    if (typeof refundId !== 'string' || refundId.length === 0) {
      throw new RefundError('INVALID_INPUT', 'refundId must be a non-empty string');
    }
    const record = this.refunds.get(refundId);
    if (!record) {
      throw new RefundError('REFUND_NOT_FOUND', `refund not found: ${refundId}`);
    }
    return record;
  }

  _refundView(record) {
    return {
      refundId: record.refundId,
      paymentId: record.paymentId,
      amount: record.amount,
      split: { ...record.split },
      status: record.status,
    };
  }

  getRefund(refundId) {
    return this._refundView(this._getRefund(refundId));
  }

  getBalance(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new RefundError('PAYMENT_NOT_FOUND', `payment not found: ${paymentId}`);
    }
    const { components, ledger } = payment;
    const available = subSplit(
      addSplit(components, ledger.compensated),
      addSplit(ledger.frozen, ledger.posted),
    );
    return {
      paymentId,
      components: { ...components },
      total: sumSplit(components),
      available,
      frozen: { ...ledger.frozen },
      posted: { ...ledger.posted },
      compensated: { ...ledger.compensated },
      refundedTotal: sumSplit(ledger.posted) - sumSplit(ledger.compensated),
    };
  }
}
