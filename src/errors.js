"use strict";

class ExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "ExitError";
    this.exitCode = exitCode;
  }
}

module.exports = { ExitError };
