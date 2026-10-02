export class FormulaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}
