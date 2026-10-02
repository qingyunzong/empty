'use strict';

class MigrateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrateError';
    this.code = code;
  }
}

const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  CONSERVATION: 25,
  SETTLED_AMOUNT: 26,
  MERGE_CROSS_ACCOUNT: 27,
};

module.exports = { MigrateError, EXIT };
