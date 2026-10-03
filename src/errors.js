// Error taxonomy for the settlement DSL.
//   E_LEX   - lexical errors (bad literals, unexpected characters)
//   E_PARSE - syntax errors
//   E_TYPE  - static type errors (no implicit conversions)
//   E_SCOPE - scoping errors (unbound names, duplicate declarations)
//   E_RT    - runtime / CLI errors
export class StlError extends Error {
  constructor(code, message, line = null, col = null) {
    super(message);
    this.name = 'StlError';
    this.code = code;
    this.line = line;
    this.col = col;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, line: this.line, col: this.col } };
  }
}

export const lexError = (message, line = null, col = null) => new StlError('E_LEX', message, line, col);
export const parseError = (message, line = null, col = null) => new StlError('E_PARSE', message, line, col);
export const typeError = (message, line = null, col = null) => new StlError('E_TYPE', message, line, col);
export const scopeError = (message, line = null, col = null) => new StlError('E_SCOPE', message, line, col);
export const rtError = (message, line = null, col = null) => new StlError('E_RT', message, line, col);
