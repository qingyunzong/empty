'use strict';

const EXIT_CODE = 7;

class LineageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LineageError';
    this.code = code;
    this.exitCode = EXIT_CODE;
  }
}

const CODES = {
  CYCLE: 'CYCLE',
  RESOURCE_EXCEEDED: 'RESOURCE_EXCEEDED',
  DUPLICATE: 'DUPLICATE',
  DUPLICATE_COMMIT: 'DUPLICATE_COMMIT',
  NOT_FOUND: 'NOT_FOUND',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  NOT_RECOMPUTABLE: 'NOT_RECOMPUTABLE',
  INVALID: 'INVALID',
};

module.exports = { LineageError, CODES, EXIT_CODE };
