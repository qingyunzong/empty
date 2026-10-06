// Error hierarchy. Input-facing errors carry 1-based line/col and an
// optional source name so the CLI can report `file:line:col: message`.

export class QcertError extends Error {
  constructor(message, { line = null, col = null, source = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.line = line;
    this.col = col;
    this.source = source;
  }
  format(sourceName = null) {
    const src = this.source ?? sourceName;
    const where = this.line != null
      ? `:${this.line}${this.col != null ? `:${this.col}` : ''}`
      : '';
    const prefix = src ? `${src}${where}` : (where ? `line${where}` : '');
    return prefix ? `${prefix}: ${this.message}` : this.message;
  }
}

export class LexError extends QcertError {}
export class ParseError extends QcertError {}
export class TypeCheckError extends QcertError {}
export class CompileError extends QcertError {}
export class VMError extends QcertError {}
export class SampleDataError extends QcertError {}
export class CertError extends QcertError {}
export class StoreError extends QcertError {}
export class IllegalRollbackError extends StoreError {}
