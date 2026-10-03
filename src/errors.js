'use strict';

const CODES = Object.freeze({
  NO_ACCOUNT: 'NO_ACCOUNT',
  CONFLICT: 'CONFLICT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ACCOUNT_EXISTS: 'ACCOUNT_EXISTS',
  TX_CLOSED: 'TX_CLOSED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
});

class StoreError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.retryable = retryable;
  }
}

module.exports = { CODES, StoreError };
