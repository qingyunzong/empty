'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { split } = require('./split');
const { LedgerError } = require('./errors');

const BRANCHES = Object.freeze(['bank', 'coupon', 'points']);

function validatePaymentId(paymentId) {
  if (typeof paymentId !== 'string' || paymentId.length === 0) {
    throw new LedgerError('INVALID_PAYMENT_ID', 'paymentId must be a non-empty string');
  }
}

function validateBranchId(branchId) {
  if (!BRANCHES.includes(branchId)) {
    throw new LedgerError('INVALID_BRANCH', `branchId must be one of: ${BRANCHES.join(', ')}`);
  }
}

function validateAmount(amount) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new LedgerError('INVALID_AMOUNT', 'amount must be a non-negative integer number of cents');
  }
}

function validateBranches(branches) {
  if (!branches || typeof branches !== 'object' || Array.isArray(branches)) {
    throw new LedgerError('INVALID_BRANCHES', 'branches must be an object with bank, coupon and points amounts');
  }
  for (const branchId of BRANCHES) {
    if (!Number.isInteger(branches[branchId]) || branches[branchId] < 0) {
      throw new LedgerError('INVALID_AMOUNT', `branch ${branchId} amount must be a non-negative integer`);
    }
  }
}

class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.log');
    fs.mkdirSync(dir, { recursive: true });
    this.payments = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.logPath)) return;
    const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) this._apply(JSON.parse(line));
    this._recover();
  }

  _apply(event) {
    const payment = this.payments.get(event.paymentId);
    switch (event.type) {
      case 'register':
        this.payments.set(event.paymentId, {
          id: event.paymentId,
          expected: { ...event.branches },
          branches: Object.fromEntries(
            BRANCHES.map((branchId) => [branchId, { status: 'PENDING', received: null }])
          ),
          status: 'PENDING',
          split: null,
          compensations: [],
        });
        break;
      case 'branch_success': {
        const branch = payment.branches[event.branchId];
        branch.status = 'SUCCESS';
        branch.received = event.amount;
        break;
      }
      case 'branch_failed': {
        const branch = payment.branches[event.branchId];
        branch.status = 'FAILED';
        branch.received = event.received ?? null;
        branch.reason = event.reason ?? '';
        payment.status = 'FAILED';
        break;
      }
      case 'compensate': {
        const branch = payment.branches[event.branchId];
        branch.status = 'COMPENSATED';
        payment.compensations.push({ branchId: event.branchId, amount: event.amount });
        break;
      }
      case 'split':
        payment.split = { ...event.split };
        payment.total = event.total;
        payment.status = 'SETTLED';
        break;
      default:
        throw new LedgerError('INVALID_EVENT', `unknown event type: ${event.type}`);
    }
  }

  _recover() {
    for (const payment of this.payments.values()) {
      if (payment.status === 'PENDING' && this._allSucceeded(payment)) {
        this._splitPayment(payment);
      }
      if (payment.status === 'FAILED') {
        this._compensateOutstanding(payment);
      }
    }
  }

  _append(event) {
    fs.appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
    this._apply(event);
  }

  _allSucceeded(payment) {
    return BRANCHES.every((branchId) => payment.branches[branchId].status === 'SUCCESS');
  }

  _compensateOutstanding(payment) {
    for (const branchId of BRANCHES) {
      const branch = payment.branches[branchId];
      if (branch.status === 'SUCCESS') {
        this._append({
          type: 'compensate',
          paymentId: payment.id,
          branchId,
          amount: branch.received,
        });
      }
    }
  }

  _splitPayment(payment) {
    const total = BRANCHES.reduce((sum, branchId) => sum + payment.branches[branchId].received, 0);
    this._append({ type: 'split', paymentId: payment.id, total, split: split(total) });
  }

  _requirePayment(paymentId) {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new LedgerError('UNKNOWN_PAYMENT', `payment ${paymentId} is not registered`);
    }
    return payment;
  }

  register(paymentId, branches) {
    validatePaymentId(paymentId);
    validateBranches(branches);
    const existing = this.payments.get(paymentId);
    if (existing) {
      if (BRANCHES.every((branchId) => existing.expected[branchId] === branches[branchId])) {
        return this.certificate(paymentId);
      }
      throw new LedgerError('CONFLICT', `payment ${paymentId} is already registered with different amounts`);
    }
    this._append({ type: 'register', paymentId, branches: { ...branches } });
    return this.certificate(paymentId);
  }

  branchSuccess(paymentId, branchId, amount) {
    validatePaymentId(paymentId);
    validateBranchId(branchId);
    validateAmount(amount);
    const payment = this._requirePayment(paymentId);
    const branch = payment.branches[branchId];
    if (branch.status === 'SUCCESS' || branch.status === 'COMPENSATED') {
      if (amount !== payment.expected[branchId]) {
        throw new LedgerError(
          'AMOUNT_MISMATCH',
          `branch ${branchId} already recorded with amount ${branch.received}`
        );
      }
      return this.certificate(paymentId);
    }
    if (payment.status === 'SETTLED') {
      if (amount === payment.expected[branchId]) return this.certificate(paymentId);
      throw new LedgerError('AMOUNT_MISMATCH', `payment ${paymentId} is already settled`);
    }
    if (amount !== payment.expected[branchId]) {
      this._append({
        type: 'branch_failed',
        paymentId,
        branchId,
        received: amount,
        reason: `amount mismatch: expected ${payment.expected[branchId]}, received ${amount}`,
      });
      this._compensateOutstanding(payment);
      return this.certificate(paymentId);
    }
    this._append({ type: 'branch_success', paymentId, branchId, amount });
    if (payment.status === 'FAILED') {
      this._compensateOutstanding(payment);
      return this.certificate(paymentId);
    }
    if (this._allSucceeded(payment)) {
      this._splitPayment(payment);
    }
    return this.certificate(paymentId);
  }

  branchFailed(paymentId, branchId, reason = '') {
    validatePaymentId(paymentId);
    validateBranchId(branchId);
    const payment = this._requirePayment(paymentId);
    const branch = payment.branches[branchId];
    if (branch.status === 'FAILED') return this.certificate(paymentId);
    if (branch.status === 'SUCCESS' || branch.status === 'COMPENSATED') {
      return this.certificate(paymentId);
    }
    if (payment.status === 'SETTLED') return this.certificate(paymentId);
    this._append({ type: 'branch_failed', paymentId, branchId, reason });
    this._compensateOutstanding(payment);
    return this.certificate(paymentId);
  }

  process(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new LedgerError('INVALID_EVENT', 'event must be a JSON object');
    }
    switch (event.type) {
      case 'register':
        return this.register(event.paymentId, event.branches);
      case 'branch_success':
        return this.branchSuccess(event.paymentId, event.branchId, event.amount);
      case 'branch_failed':
        return this.branchFailed(event.paymentId, event.branchId, event.reason);
      default:
        throw new LedgerError('INVALID_EVENT', `unknown event type: ${event.type}`);
    }
  }

  certificate(paymentId) {
    const payment = this._requirePayment(paymentId);
    return {
      paymentId: payment.id,
      status: payment.status,
      expected: { ...payment.expected },
      total: BRANCHES.reduce((sum, branchId) => sum + payment.expected[branchId], 0),
      branches: Object.fromEntries(
        BRANCHES.map((branchId) => [branchId, { ...payment.branches[branchId] }])
      ),
      split: payment.split ? { ...payment.split } : null,
      compensations: payment.compensations.map((entry) => ({ ...entry })),
    };
  }
}

module.exports = { Ledger, BRANCHES };
