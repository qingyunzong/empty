export class PackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackError';
    this.code = code;
  }
}

export class CrashInjected extends Error {
  constructor(point) {
    super(`crash injected at ${point}`);
    this.name = 'CrashInjected';
    this.point = point;
  }
}
