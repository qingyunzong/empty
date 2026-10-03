'use strict';

// Exit code 12 is reserved for input/integrity validation failures:
// sequence gaps, hash mismatches, duplicate event ids inside a macro-step,
// corrupt WAL/checkpoint data, and malformed input records.
const EXIT_VALIDATION = 12;
const EXIT_USAGE = 2;

class MonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MonitorError';
    this.code = code;
    this.exitCode = EXIT_VALIDATION;
  }
}

module.exports = { MonitorError, EXIT_VALIDATION, EXIT_USAGE };
