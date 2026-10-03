'use strict';

class LogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LogError';
    this.code = code;
  }
}

module.exports = { LogError };
