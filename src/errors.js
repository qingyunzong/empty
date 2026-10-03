'use strict';

class RejectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RejectError';
    this.code = 'REJECTED';
  }
}

class CorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptError';
    this.code = 'CORRUPT';
  }
}

module.exports = { RejectError, CorruptError };
