export const E = Object.freeze({
  DUP_RULE: 'E_DUP_RULE',
  EVIDENCE_GONE: 'E_EVIDENCE_GONE',
  UNDECIDED: 'E_UNDECIDED',
  CERT_MISMATCH: 'E_CERT_MISMATCH',
});

export class EvpackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvpackError';
    this.code = code;
  }
}
