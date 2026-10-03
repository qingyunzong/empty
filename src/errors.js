export const E_WAL = 'E_WAL';
export const E_RECOVER = 'E_RECOVER';
export const E_INVARIANT = 'E_INVARIANT';
export const E_IO = 'E_IO';

export class LedgerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** Simulated process crash at a WAL fault-injection point. Not a ledger failure. */
export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash after ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}
