export class AlertError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AlertError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
