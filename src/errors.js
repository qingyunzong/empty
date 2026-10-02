export class AuditError extends Error {
  constructor(code, message, range = null) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.range = range;
  }

  toJSON() {
    return { code: this.code, message: this.message, range: this.range ?? null };
  }
}
