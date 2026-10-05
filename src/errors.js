'use strict';

class QGError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QGError';
    this.code = code;
  }
}

module.exports = { QGError };
