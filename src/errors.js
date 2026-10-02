'use strict';

class QueryError extends Error {
  constructor(message, pos) {
    super(pos != null ? `${message} (at offset ${pos})` : message);
    this.name = 'QueryError';
  }
}

class RecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryError';
  }
}

module.exports = { QueryError, RecoveryError };
