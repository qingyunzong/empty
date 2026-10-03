export class ZoneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZoneError';
    this.code = code;
  }
}
