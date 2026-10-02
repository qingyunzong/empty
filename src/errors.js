'use strict';

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

class CorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptError';
  }
}

module.exports = { BusinessError, CorruptError };
