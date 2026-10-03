export const EXIT = {
  MISSING_PARENT: 22,
  OUT_OF_BOUNDS: 23,
  SAME_AUTH: 24,
};

export class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}
