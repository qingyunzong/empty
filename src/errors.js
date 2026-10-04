export class WipError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = 'WipError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at fault point: ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

export const validationError = (message) => new WipError('VALIDATION', message, 2);
export const stateError = (code, message) => new WipError(code, message, 3);
