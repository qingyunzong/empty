export class QuotaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
  }
}

export const isQuotaError = (e) => e instanceof QuotaError;
