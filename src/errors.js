export class TraceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
