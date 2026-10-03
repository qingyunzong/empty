'use strict';

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

module.exports = { LedgerError };
