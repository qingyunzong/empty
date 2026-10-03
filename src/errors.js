export const E_TIME_ORDER = 'E_TIME_ORDER';
export const E_TOMBSTONE = 'E_TOMBSTONE';
export const E_REF = 'E_REF';

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}
