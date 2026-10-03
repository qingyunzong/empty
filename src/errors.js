export class QError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QError';
    this.code = code;
  }
}
