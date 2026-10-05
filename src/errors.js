'use strict';

class RcError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

module.exports = { RcError };
