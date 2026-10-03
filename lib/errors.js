'use strict';

class LedgerError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

const crossDay = (msg) => new LedgerError('E_CROSS_DAY', 21, msg);
const planInvalid = (msg) => new LedgerError('E_PLAN_INVALID', 22, msg);
const recoverAmbiguous = (msg) => new LedgerError('E_RECOVER_AMBIGUOUS', 23, msg);

module.exports = { LedgerError, CrashError, crossDay, planInvalid, recoverAmbiguous };
