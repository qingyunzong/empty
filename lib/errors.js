'use strict';

class PolicyError extends Error {
  constructor(code, line, message) {
    super(message || `${code} at line ${line}`);
    this.name = 'PolicyError';
    this.code = code;
    this.line = line;
  }
}

module.exports = { PolicyError };
