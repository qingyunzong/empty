export const E_STOCK = 'E_STOCK';
export const E_SAVEPOINT = 'E_SAVEPOINT';
export const E_CRC = 'E_CRC';
export const E_VALID = 'E_VALID';

export class LedgerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
