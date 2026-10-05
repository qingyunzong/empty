'use strict';

class WipError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = 'WipError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

// exit 2: validation / usage errors
const validation = (code, message) => new WipError(code, message, 2);
// exit 3: state conflicts (CLOSED, NOT_FOUND, ...)
const state = (code, message) => new WipError(code, message, 3);
// exit 10: verify detected divergence
const verify = (code, message) => new WipError(code, message, 10);

module.exports = { WipError, validation, state, verify };
