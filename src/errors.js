'use strict';

class LabError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LabError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { LabError };
