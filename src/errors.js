export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.exitCode = 2;
  }
}

export class CrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrashError';
    this.code = 'SIMULATED_CRASH';
    this.exitCode = 70;
  }
}
