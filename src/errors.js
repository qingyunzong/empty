'use strict';

const CODES = Object.freeze({
  NFA_EPSILON_ONLY: 'NFA_EPSILON_ONLY',
  TIME_REORDER: 'TIME_REORDER',
  ID_REUSE: 'ID_REUSE',
  CACHE_POISON: 'CACHE_POISON',
  LOG_LIMIT: 'LOG_LIMIT',
  STATE_LIMIT: 'STATE_LIMIT',
  INVALID_NFA: 'INVALID_NFA',
  INVALID_EVENT: 'INVALID_EVENT',
});

class ComplianceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ComplianceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CODES, ComplianceError };
