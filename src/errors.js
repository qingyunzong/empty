'use strict';

class AuditError extends Error {
  constructor(message, exitCode, seq) {
    super(message);
    this.name = 'AuditError';
    this.exitCode = exitCode;
    if (seq !== undefined) this.seq = seq;
  }
}

module.exports = { AuditError };
