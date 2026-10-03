'use strict';

class JeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JeError';
    this.code = code;
  }
}

const EXIT_CRASH = 75;

module.exports = { JeError, EXIT_CRASH };
