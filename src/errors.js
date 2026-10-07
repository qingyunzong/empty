export class QError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QError';
    this.code = code;
  }
}
export const scopeErr = (m) => new QError('E_SCOPE', m);
export const typeErr = (m) => new QError('E_TYPE', m);
export const capErr = (m) => new QError('E_CAP', m);
export const expiredErr = (m) => new QError('E_EXPIRED', m);
export const noteErr = (m) => new QError('E_NOTE', m);
