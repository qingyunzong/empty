export class ExitError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'ExitError';
    this.exitCode = exitCode;
  }
}
