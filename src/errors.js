export class DslError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'DslError';
    this.line = line;
  }
}

export class InputError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'InputError';
    this.line = line;
  }
}

export class VerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyError';
  }
}

export class RuntimeFault extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeFault';
  }
}
