'use strict';

class QlinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QlinError';
    this.code = code;
  }
}

module.exports = { QlinError };
