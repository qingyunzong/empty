export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code; // E_PARSE | E_REF | E_STATE | E_IO
    if (details !== undefined) this.details = details;
  }
}
