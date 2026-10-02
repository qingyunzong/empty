export class CalError extends Error {
  constructor(code, message, exitCode = 6) {
    super(message);
    this.name = 'CalError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
