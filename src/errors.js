'use strict';

class DslError extends Error {
  constructor(code, message, line = 0, col = 0) {
    super(message);
    this.name = 'DslError';
    this.code = code;
    this.line = line;
    this.col = col;
  }
  toJSON() {
    return { code: this.code, message: this.message, line: this.line, col: this.col };
  }
}

module.exports = { DslError };
