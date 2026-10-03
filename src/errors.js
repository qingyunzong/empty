'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.exitCode = 7;
  }
}

class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
    this.exitCode = 2;
  }
}

module.exports = { InputError, PlanError };
