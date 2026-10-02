export const E = Object.freeze({
  TRANSITION: 'E_TRANSITION',
  LOCKED: 'E_LOCKED',
  NOT_FOUND: 'E_NOT_FOUND',
  DUPLICATE: 'E_DUPLICATE',
  VALIDATION: 'E_VALIDATION',
  IO: 'E_IO',
  USAGE: 'E_USAGE',
});

export class CardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CardError';
    this.code = code;
  }
}
