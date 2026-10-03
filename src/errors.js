export const E_TOKEN = 'E_TOKEN';
export const E_SPAN = 'E_SPAN';
export const E_CERT = 'E_CERT';

export class IndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
  }
}
