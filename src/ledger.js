import fs from 'node:fs';
import path from 'node:path';
import { splitAmount } from './split.js';

export const BRANCHES = Object.freeze(['card', 'coupon', 'points']);

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function emptyPayment(id) {
  const branches = {};
  for (const b of BRANCHES) branches[b] = { status: 'pending', amount: null };
  return {
    id,
    status: 'PROCESSING', // PROCESSING | COMPLETED | FAILED
    expected: null,
    branches,
    split: null,
    compensations: [],
  };
}

export class Ledger {
  constructor(workdir) {
    if (typeof workdir !== 'string' || workdir.length === 0) {
      throw new LedgerError('INVALID_WORKDIR', 'workdir must be a non-empty path');
    }
    this.workdir = workdir;
    fs.mkdirSync(workdir, { recursive: true });
    this.logPath = path.join(workdir, 'events.log');
    this.payments = new Map();
    this.seq = 0;
    this._replay();
  }

  _replay() {
    if (!fs.existsSync(this.logPath)) return;
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      const event = JSON.parse(line);
      this.seq = Math.max(this.seq, event.seq);
      this._apply(event);
    }
  }

  _append(event) {
    const full = { seq: this.seq + 1, ...event };
    fs.appendFileSync(this.logPath, JSON.stringify(full) + '\n');
    this._apply(full);
    this.seq = full.seq;
    return full;
  }

  _apply(event) {
    const payment = this.payments.get(event.paymentId);
    switch (event.type) {
      case 'order': {
        if (!payment) {
          const p = emptyPayment(event.paymentId);
          p.expected = { ...event.expected };
          this.payments.set(event.paymentId, p);
        }
        break;
      }
      case 'branch_success': {
        const p = payment ?? this._lazyPayment(event.paymentId);
        p.branches[event.branchId] = { status: 'succeeded', amount: event.amount };
        break;
      }
      case 'branch_failure': {
        const p = payment ?? this._lazyPayment(event.paymentId);
        p.branches[event.branchId] = { status: 'failed', amount: event.amount ?? null };
        p.status = 'FAILED';
        break;
      }
      case 'compensation': {
        const p = payment ?? this._lazyPayment(event.paymentId);
        p.compensations.push({ branchId: event.branchId, amount: event.amount });
        if (p.branches[event.branchId].status === 'succeeded') {
          p.branches[event.branchId].status = 'compensated';
        }
        break;
      }
      case 'split': {
        const p = payment ?? this._lazyPayment(event.paymentId);
        p.split = { ...event.split };
        p.status = 'COMPLETED';
        break;
      }
      default:
        throw new LedgerError('CORRUPT_LOG', `unknown event type in log: ${event.type}`);
    }
  }

  _lazyPayment(id) {
    const p = emptyPayment(id);
    this.payments.set(id, p);
    return p;
  }

  _getOrCreate(id) {
    return this.payments.get(id) ?? this._lazyPayment(id);
  }

  createOrder(paymentId, expected) {
    this._assertPaymentId(paymentId);
    const existing = this.payments.get(paymentId);
    if (existing?.expected) {
      for (const b of BRANCHES) {
        if (existing.expected[b] !== expected[b]) {
          throw new LedgerError('DUPLICATE_CONFLICT', `order ${paymentId} already exists with different expectations`);
        }
      }
      return this.certificate(paymentId);
    }
    const normalized = {};
    for (const b of BRANCHES) {
      const amount = expected?.[b] ?? 0;
      this._assertAmount(amount, `expected.${b}`);
      normalized[b] = amount;
    }
    this._append({ type: 'order', paymentId, expected: normalized });
    return this.certificate(paymentId);
  }

  handleEvent(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new LedgerError('INVALID_EVENT', 'event must be a JSON object');
    }
    switch (event.type) {
      case 'order_created':
        return this.createOrder(event.paymentId, event.expected ?? {});
      case 'branch_result':
        return this.handleBranchResult(event);
      default:
        throw new LedgerError('INVALID_EVENT', `unknown event type: ${String(event.type)}`);
    }
  }

  handleBranchResult({ paymentId, branchId, status, amount }) {
    this._assertPaymentId(paymentId);
    if (!BRANCHES.includes(branchId)) {
      throw new LedgerError('INVALID_BRANCH', `branchId must be one of ${BRANCHES.join(', ')}, got ${String(branchId)}`);
    }
    if (status !== 'success' && status !== 'failed') {
      throw new LedgerError('INVALID_EVENT', `status must be "success" or "failed", got ${String(status)}`);
    }
    if (status === 'success') this._assertAmount(amount, 'amount');
    if (status === 'failed' && amount !== undefined && amount !== null) this._assertAmount(amount, 'amount');

    const payment = this._getOrCreate(paymentId);
    const branch = payment.branches[branchId];

    // Idempotency: a repeated notification for the same branch is a no-op
    // when it carries identical content; a conflicting repeat is rejected.
    if (branch.status !== 'pending') {
      const recordedAmount = branch.amount;
      const sameStatus =
        (branch.status === 'failed' && status === 'failed') ||
        (branch.status !== 'failed' && status === 'success');
      const sameAmount = status === 'failed' || recordedAmount === amount;
      if (sameStatus && sameAmount) return this.certificate(paymentId);
      throw new LedgerError(
        'DUPLICATE_CONFLICT',
        `branch ${branchId} of payment ${paymentId} already recorded with status=${branch.status} amount=${recordedAmount}`,
      );
    }

    if (payment.status === 'COMPLETED') {
      throw new LedgerError('PAYMENT_COMPLETED', `payment ${paymentId} is already completed`);
    }

    const mismatched =
      status === 'success' && payment.expected !== null && payment.expected[branchId] !== amount;

    if (status === 'failed' || mismatched) {
      this._append({
        type: 'branch_failure',
        paymentId,
        branchId,
        amount: status === 'success' ? amount : amount ?? null,
        reason: mismatched ? 'amount_mismatch' : 'branch_failed',
      });
      this._compensateAll(paymentId);
      return this.certificate(paymentId);
    }

    this._append({ type: 'branch_success', paymentId, branchId, amount });

    if (payment.status === 'FAILED') {
      // Late success after the order already failed: compensate immediately.
      this._compensateAll(paymentId);
      return this.certificate(paymentId);
    }

    if (BRANCHES.every((b) => payment.branches[b].status === 'succeeded')) {
      const total = BRANCHES.reduce((sum, b) => sum + payment.branches[b].amount, 0);
      this._append({ type: 'split', paymentId, split: splitAmount(total) });
    }
    return this.certificate(paymentId);
  }

  _compensateAll(paymentId) {
    const payment = this.payments.get(paymentId);
    for (const b of BRANCHES) {
      if (payment.branches[b].status === 'succeeded') {
        this._append({ type: 'compensation', paymentId, branchId: b, amount: payment.branches[b].amount });
      }
    }
  }

  certificate(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new LedgerError('PAYMENT_NOT_FOUND', `unknown paymentId: ${String(paymentId)}`);
    const branches = {};
    let received = 0;
    for (const b of BRANCHES) {
      branches[b] = { ...payment.branches[b] };
      if (payment.branches[b].status === 'succeeded') received += payment.branches[b].amount;
    }
    return {
      paymentId: payment.id,
      status: payment.status,
      branches,
      received,
      split: payment.split ? { ...payment.split } : null,
      compensations: payment.compensations.map((c) => ({ ...c })),
    };
  }

  _assertPaymentId(paymentId) {
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new LedgerError('INVALID_EVENT', 'paymentId must be a non-empty string');
    }
  }

  _assertAmount(amount, field) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new LedgerError('INVALID_AMOUNT', `${field} must be a non-negative integer of cents, got ${String(amount)}`);
    }
  }
}
