'use strict';

class SchedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { SchedError };
