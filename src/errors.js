export const E = Object.freeze({
  CRC: 'E_CRC',
  REFERENCE: 'E_REFERENCE',
  NOT_FOUND: 'E_NOT_FOUND',
  INVALID: 'E_INVALID',
  EXISTS: 'E_EXISTS',
});

export class QcError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'QcError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
