export class RundiffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RundiffError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new RundiffError(code, message);
}
