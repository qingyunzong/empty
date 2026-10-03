export const ExitCode = {
  OK: 0,
  USAGE: 1,
  NO_SUCH_TXN: 2,
  CHECKSUM_MISMATCH: 3,
  AUDIT_DIVERGENCE: 4,
  INJECTED_CRASH: 75,
};

export class WalError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class InjectedCrashError extends Error {
  constructor(point, txn) {
    super(`injected crash at ${point} (txn ${txn})`);
    this.name = 'InjectedCrashError';
    this.point = point;
    this.txn = txn;
  }
}
