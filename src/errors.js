export const E_DUP_RULE = 'E_DUP_RULE';
export const E_EVIDENCE_GONE = 'E_EVIDENCE_GONE';
export const E_UNDECIDED = 'E_UNDECIDED';
export const E_CERT_MISMATCH = 'E_CERT_MISMATCH';
export const E_INVALID = 'E_INVALID';

export class EvpackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvpackError';
    this.code = code;
  }
}
