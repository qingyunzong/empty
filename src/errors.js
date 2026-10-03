export class FeeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'FeeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const err = (code, message, detail) => new FeeError(code, message, detail);
