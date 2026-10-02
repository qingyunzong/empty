export class DispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
  }
}
