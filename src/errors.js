export class TraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
  }
}
