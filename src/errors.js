export class DslError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'DslError';
    this.line = line;
    this.col = col;
  }
}

export class DslErrorList extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.line}:${e.col}: ${e.message}`).join('\n'));
    this.name = 'DslErrorList';
    this.errors = errors;
  }
}
