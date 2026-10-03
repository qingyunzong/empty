export class CaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaError';
    this.code = code;
  }
}
