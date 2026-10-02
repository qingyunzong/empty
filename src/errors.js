'use strict';

class CodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodeError';
    this.code = code;
  }
}

const E_CONFIG = (msg) => new CodeError('E_CONFIG', msg);
const E_RATIONAL = (msg) => new CodeError('E_RATIONAL', msg);
const E_AMBIGUOUS = (msg) => new CodeError('E_AMBIGUOUS', msg);
const E_TRANSACTION = (msg) => new CodeError('E_TRANSACTION', msg);
const E_DEGREE = (msg) => new CodeError('E_DEGREE', msg);

module.exports = { CodeError, E_CONFIG, E_RATIONAL, E_AMBIGUOUS, E_TRANSACTION, E_DEGREE };
