'use strict';

const CODES = Object.freeze({
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NEGATIVE: 'NEGATIVE',
  HOLD_LEAK: 'HOLD_LEAK',
  FORK_CONFLICT: 'FORK_CONFLICT',
  CORRUPT_JOURNAL: 'CORRUPT_JOURNAL',
});

class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CODES, LedgerError };
