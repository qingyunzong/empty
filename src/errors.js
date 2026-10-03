'use strict';

class FlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
  }
}

module.exports = { FlowError };
