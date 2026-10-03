export class GateError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'GateError';
    this.exitCode = exitCode;
  }
}
