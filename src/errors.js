'use strict';

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const E = {
  transition: (id, state, op) =>
    new LedgerError('E_TRANSITION', `txn ${id}: cannot apply "${op}" in state "${state}"`),
  locked: (id, day, through) =>
    new LedgerError('E_LOCKED', `txn ${id}: capture on ${day} is locked by settlement through ${through}`),
  notFound: (id) => new LedgerError('E_NOT_FOUND', `unknown transaction id: ${id}`),
  duplicate: (id) => new LedgerError('E_VALIDATION', `duplicate transaction id: ${id}`),
  validation: (msg) => new LedgerError('E_VALIDATION', msg),
  parse: (line, msg) => new LedgerError('E_PARSE', `line ${line}: ${msg}`),
  usage: (msg) => new LedgerError('E_USAGE', msg),
};

module.exports = { LedgerError, E };
