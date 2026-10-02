'use strict';

class PacklineError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'PacklineError';
    this.exitCode = exitCode;
  }
}

const EXIT = {
  OK: 0,
  GENERAL: 1,
  FRAME: 2,
  REF_UNKNOWN: 9,
  TERMINAL: 10,
};

function frameError(message) {
  return new PacklineError(message, EXIT.FRAME);
}

function refError(message) {
  return new PacklineError(message, EXIT.REF_UNKNOWN);
}

function terminalError(message) {
  return new PacklineError(message, EXIT.TERMINAL);
}

module.exports = { PacklineError, EXIT, frameError, refError, terminalError };
