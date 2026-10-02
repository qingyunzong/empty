export const EXIT = Object.freeze({
  NEGATIVE_STOCK: 19,
  UNKNOWN_CURRENCY: 20,
  DUPLICATE_DEFECT: 21,
});

export class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}
