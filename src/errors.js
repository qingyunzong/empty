'use strict';

class RepoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}

class ConflictError extends RepoError {
  constructor(message, conflicts) {
    super(message, 1);
    this.conflicts = conflicts || [];
  }
}

class UnknownOrderError extends RepoError {
  constructor(id) {
    super('unknown order: ' + id, 2);
    this.orderId = id;
  }
}

class InvalidPatchError extends RepoError {
  constructor(message) {
    super(message, 2);
  }
}

module.exports = { RepoError, ConflictError, UnknownOrderError, InvalidPatchError };
