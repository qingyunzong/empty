'use strict';

class CodedError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}

// exit 2: malformed frame / invalid event content
class FrameError extends CodedError {
  constructor(message) { super(message, 2); }
}

// exit 9: CORRECT references an unknown event
class RefNotFoundError extends CodedError {
  constructor(message) { super(message, 9); }
}

// exit 10: terminal-state (SCRAP) violation
class TerminalViolationError extends CodedError {
  constructor(message) { super(message, 10); }
}

module.exports = { CodedError, FrameError, RefNotFoundError, TerminalViolationError };
