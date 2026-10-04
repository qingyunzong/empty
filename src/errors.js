export class BusinessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.details = details;
    this.exitCode = 1;
  }
}

export class CorruptionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CorruptionError';
    this.code = 'ERR_CORRUPT';
    this.details = details;
    this.exitCode = 2;
  }
}

export class InjectedCrash extends Error {
  constructor(point) {
    super(`injected crash at ${point}`);
    this.name = 'InjectedCrash';
    this.point = point;
    this.injected = true;
    this.exitCode = 3;
  }
}
