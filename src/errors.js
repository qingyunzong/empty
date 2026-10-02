'use strict';

const CODES = Object.freeze({
  SNAP: 'E_SNAP',
  DEPEND: 'E_DEPEND',
  ORPHAN: 'E_ORPHAN',
  BOUNDARY: 'E_BOUNDARY',
});

class LedgerError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CODES, LedgerError };
