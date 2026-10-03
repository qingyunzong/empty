'use strict';

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
    this.code = 'BUSINESS';
    this.exitCode = 1;
  }
}

class CorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptError';
    this.code = 'CORRUPT';
    this.exitCode = 2;
  }
}

module.exports = { BusinessError, CorruptError };
