'use strict';

class FormulaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    Object.assign(this, details);
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    for (const k of ['position', 'column', 'variable', 'left', 'right', 'expected', 'actual']) {
      if (this[k] !== undefined) out[k] = this[k];
    }
    return out;
  }
}

function parseError(message, position) {
  return new FormulaError('PARSE_ERROR', message, { position, column: position + 1 });
}

function dimensionMismatch(message, details) {
  return new FormulaError('DIMENSION_MISMATCH', message, details);
}

function unknownVariable(name, position) {
  return new FormulaError('UNKNOWN_VARIABLE', `unknown variable "${name}" at column ${position + 1}`, {
    variable: name,
    position,
    column: position + 1,
  });
}

module.exports = { FormulaError, parseError, dimensionMismatch, unknownVariable };
