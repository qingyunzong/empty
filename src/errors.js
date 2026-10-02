export const E_KEY = 'E_KEY';
export const E_PROOF = 'E_PROOF';
export const E_PARTIAL_HIDDEN = 'E_PARTIAL_HIDDEN';
export const E_STALE_PROOF = 'E_STALE_PROOF';

export class ProvError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProvError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
