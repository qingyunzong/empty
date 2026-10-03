'use strict';

class QueryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class QuerySyntaxError extends QueryError {
  constructor(message) { super(message, 'SYNTAX'); }
}

class QuerySchemaError extends QueryError {
  constructor(message) { super(message, 'SCHEMA'); }
}

class QueryTypeError extends QueryError {
  constructor(message) { super(message, 'TYPE'); }
}

class QueryRegexError extends QueryError {
  constructor(message) { super(message, 'REGEX'); }
}

class QueryBudgetError extends QueryError {
  constructor(message) { super(message, 'BUDGET'); }
}

class QueryRuntimeError extends QueryError {
  constructor(message) { super(message, 'RUNTIME'); }
}

module.exports = {
  QueryError,
  QuerySyntaxError,
  QuerySchemaError,
  QueryTypeError,
  QueryRegexError,
  QueryBudgetError,
  QueryRuntimeError,
};
