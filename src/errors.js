'use strict';

class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.details = details || {};
  }
}

module.exports = { AuditError };
