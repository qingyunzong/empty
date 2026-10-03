'use strict';

class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

module.exports = { DbError };
