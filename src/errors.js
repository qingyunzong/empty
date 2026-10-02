export const CODES = Object.freeze({
  BROKEN_CHAIN: 'BROKEN_CHAIN',
  REVOKED_CONSENT: 'REVOKED_CONSENT',
  NO_PROOF: 'NO_PROOF',
  INVALID_EVENT: 'INVALID_EVENT',
});

export class ChainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
