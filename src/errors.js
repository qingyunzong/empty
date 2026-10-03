'use strict';

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const NOT_FOUND = 'NOT_FOUND';
const INVALID = 'INVALID';
const CONFLICT = 'CONFLICT';

module.exports = { StoreError, NOT_FOUND, INVALID, CONFLICT };
