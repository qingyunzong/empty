"use strict";

const EXIT_DATA_ERROR = 5;

const CODES = Object.freeze({
  VOLUME_EXCEEDS_PLATE: "VOLUME_EXCEEDS_PLATE",
  BUDGET_NEGATIVE: "BUDGET_NEGATIVE",
  COOLDOWN_CONFLICT: "COOLDOWN_CONFLICT",
});

class LabError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LabError";
    this.code = code;
    this.exitCode = EXIT_DATA_ERROR;
  }
}

module.exports = { LabError, CODES, EXIT_DATA_ERROR };
