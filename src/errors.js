export class RefundError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}
