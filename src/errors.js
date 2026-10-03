'use strict';

class QuotaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'QuotaError';
    this.code = code;
  }
}

const E_DEADLOCK = 'E_DEADLOCK';
const E_LOCK_TIMEOUT = 'E_LOCK_TIMEOUT';
const E_INSUFFICIENT_FUNDS = 'E_INSUFFICIENT_FUNDS';
const E_TXN_STATE = 'E_TXN_STATE';
const E_NOT_FOUND = 'E_NOT_FOUND';

module.exports = {
  QuotaError,
  E_DEADLOCK,
  E_LOCK_TIMEOUT,
  E_INSUFFICIENT_FUNDS,
  E_TXN_STATE,
  E_NOT_FOUND,
};
