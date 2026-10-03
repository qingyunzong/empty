"use strict";

const EXIT_CODES = {
  E_NO_KEY: 10,
  E_TOL: 11,
  E_AMBIG_MIN: 12,
  E_SNAP: 13,
};

class SnapError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = "SnapError";
    this.code = code;
    this.details = details;
  }
  get exitCode() {
    return EXIT_CODES[this.code] || 1;
  }
}

// Simulated crash (fault injection for tests / SNAPDIFF_CRASH): aborts the
// process with exit code 3 after state was partially written.
class CrashError extends Error {
  constructor(message) {
    super(message || "simulated crash");
    this.name = "CrashError";
    this.code = "E_CRASH";
  }
  get exitCode() {
    return 3;
  }
}

module.exports = { SnapError, CrashError, EXIT_CODES };
