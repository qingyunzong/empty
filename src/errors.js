export const ERR = {
  DUP_ID: 'DUP_ID',
  CURRENCY_MIX: 'CURRENCY_MIX',
  SEARCH_BOUND: 'SEARCH_BOUND',
  CERT_INVALID: 'CERT_INVALID',
  INPUT_INVALID: 'INPUT_INVALID',
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
};

export class ReconError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
