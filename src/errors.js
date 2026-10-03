export class DslError extends Error {
  constructor(message, loc = {}) {
    super(message);
    this.name = 'DslError';
    this.file = loc.file ?? '<input>';
    this.line = loc.line ?? 0;
    this.col = loc.col ?? 0;
  }

  toString() {
    return `${this.file}:${this.line}:${this.col}: error: ${this.message}`;
  }
}
