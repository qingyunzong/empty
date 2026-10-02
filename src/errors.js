'use strict';

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

class QueryTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryTypeError';
  }
}

class RegexCompileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegexCompileError';
  }
}

class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

module.exports = {
  ParseError,
  QueryTypeError,
  RegexCompileError,
  BudgetExceededError,
};
