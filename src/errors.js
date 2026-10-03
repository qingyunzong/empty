export class LedgerError extends Error {
  constructor(code, message, range = null, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.range = range;
    if (details !== undefined) this.details = details;
  }
}
