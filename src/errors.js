export class TxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TxError';
    this.code = code;
  }
}

export const CONFLICT = 'CONFLICT';
export const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';
export const NO_ACCOUNT = 'NO_ACCOUNT';
export const ACCOUNT_EXISTS = 'ACCOUNT_EXISTS';

export class ConflictError extends TxError {
  constructor(msg) { super(CONFLICT, msg); }
}
export class BudgetExceededError extends TxError {
  constructor(msg) { super(BUDGET_EXCEEDED, msg); }
}
export class NoAccountError extends TxError {
  constructor(msg) { super(NO_ACCOUNT, msg); }
}
export class AccountExistsError extends TxError {
  constructor(msg) { super(ACCOUNT_EXISTS, msg); }
}
// Simulated crash injected by tests during WAL append.
export class CrashError extends Error {
  constructor(msg) { super(msg); this.name = 'CrashError'; }
}
