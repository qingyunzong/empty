export class ChainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.details = details;
  }
}

export const BROKEN_CHAIN = 'BROKEN_CHAIN';
export const REVOKED_CONSENT = 'REVOKED_CONSENT';
export const NO_PROOF = 'NO_PROOF';

export function brokenChain(message, details) {
  return new ChainError(BROKEN_CHAIN, message, details);
}

export function revokedConsent(message, details) {
  return new ChainError(REVOKED_CONSENT, message, details);
}

export function noProof(message, details) {
  return new ChainError(NO_PROOF, message, details);
}
