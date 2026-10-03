export class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BusinessError";
    this.code = code;
    this.exitCode = 1;
  }
}

export class CorruptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CorruptError";
    this.code = code;
    this.exitCode = 2;
  }
}

export class ForkError extends CorruptError {
  constructor(message) {
    super("FORK", message);
    this.name = "ForkError";
  }
}
