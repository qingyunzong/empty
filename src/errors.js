export const E_DEADLOCK = 'E_DEADLOCK';
export const E_LOCK_TIMEOUT = 'E_LOCK_TIMEOUT';
export const E_INSUFFICIENT = 'E_INSUFFICIENT';
export const E_NOT_FOUND = 'E_NOT_FOUND';
export const E_INVALID = 'E_INVALID';

export class DbError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'DbError';
    this.code = code;
  }
}
