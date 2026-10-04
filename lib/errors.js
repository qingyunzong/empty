export const EXIT_INPUT_ERROR = 2;

export class CertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CertError';
    this.code = code;
  }
}
