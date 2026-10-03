export class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.exitCode = 1;
  }
}

export class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError';
    this.code = 'CORRUPTION';
    this.exitCode = 2;
  }
}
