'use strict';

const CODES = Object.freeze({
  E_TZVER: 'E_TZVER',     // timezone table version problems (unknown version, immutable-version conflict, missing leap mapping)
  E_AMBIG: 'E_AMBIG',     // ambiguous / nonexistent local time under strict policy
  E_POLICY: 'E_POLICY',   // invalid policy or invalid policy-dependent configuration
  E_REPLAY: 'E_REPLAY',   // attempt to rewrite finalized history with a different table version
});

class ReconError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isReconError(err) {
  return err instanceof ReconError;
}

module.exports = { CODES, ReconError, isReconError };
