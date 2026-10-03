export class EscrowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EscrowError';
    this.code = code;
  }
}
