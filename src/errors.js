'use strict';

class PlanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

// Stable, non-zero process exit codes per error code.
const EXIT_CODES = {
  E_USAGE: 1,
  E_CRC: 2,
  E_INDEX: 3,
  E_CAPACITY: 4,
  E_STATE: 5,
  E_IO: 6,
};

module.exports = { PlanError, EXIT_CODES };
