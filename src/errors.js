export class QrecError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'QrecError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
