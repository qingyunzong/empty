'use strict';

class QError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QError';
    this.code = code;
  }
}

const E_PARSE = (msg) => new QError('E_PARSE', msg);
const E_TYPE = (msg) => new QError('E_TYPE', msg);
const E_NON_EQUIV = (msg) => new QError('E_NON_EQUIV', msg);
const E_UNSUPPORTED = (msg) => new QError('E_UNSUPPORTED', msg);

module.exports = { QError, E_PARSE, E_TYPE, E_NON_EQUIV, E_UNSUPPORTED };
