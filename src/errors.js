export class ProvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProvError';
    this.code = code;
  }
}

export const EXIT_CODES = {
  E_KEY: 2,
  E_PROOF: 3,
  E_PARTIAL_HIDDEN: 4,
  E_STALE_PROOF: 5,
};
