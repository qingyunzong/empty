export const ErrorCodes = Object.freeze({
  RATE_STALE: 'RATE_STALE',
  RATE_MISSING: 'RATE_MISSING',
  LIMIT: 'LIMIT',
  CYCLE_LOCKED: 'CYCLE_LOCKED',
  NEGATIVE_RELEASE: 'NEGATIVE_RELEASE',
  INPUT_INVALID: 'INPUT_INVALID',
});

export class NettingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NettingError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}
