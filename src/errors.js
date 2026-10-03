'use strict';

class CalendarError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const ERR = {
  ZERO_PERIOD: 'ZERO_PERIOD',
  INTERVAL_INVERSION: 'INTERVAL_INVERSION',
  UNKNOWN_SAVEPOINT: 'UNKNOWN_SAVEPOINT',
  REVISION: 'REVISION',
  NO_TRANSACTION: 'NO_TRANSACTION',
  VALIDATION: 'VALIDATION',
};

module.exports = { CalendarError, ERR };
