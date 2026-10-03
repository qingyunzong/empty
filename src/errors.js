export const CODES = Object.freeze({
  RATE_STALE: 'RATE_STALE',
  LIMIT: 'LIMIT',
  CYCLE_LOCKED: 'CYCLE_LOCKED',
  NEGATIVE_RELEASE: 'NEGATIVE_RELEASE',
  INVALID_INPUT: 'INVALID_INPUT',
});

export class ClearingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
