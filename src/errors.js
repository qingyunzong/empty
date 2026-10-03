export const EXIT = { OK: 0, VALIDATION: 2, PENDING: 3, CERT: 7 };

export class LotError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LotError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
