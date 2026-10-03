'use strict';

class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

module.exports = { ExitError, FrameError };
