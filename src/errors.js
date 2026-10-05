'use strict';

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
    this.exitCode = 3;
  }
}

class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
    this.exitCode = 5;
  }
}

module.exports = { ProtocolError, BudgetError };
