export class MvError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MvError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export const err = (code, message, details) => new MvError(code, message, details);
