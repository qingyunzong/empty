export class AgvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgvError';
    this.code = code;
  }
}
