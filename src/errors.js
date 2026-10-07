'use strict';

const CODES = Object.freeze({
  TZVER: 'E_TZVER',
  AMBIG: 'E_AMBIG',
  POLICY: 'E_POLICY',
  REPLAY: 'E_REPLAY',
});

class ReconError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CODES, ReconError };
