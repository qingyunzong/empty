export class LError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const segError = (m) => new LError('E_SEG', m);
export const dayError = (m) => new LError('E_DAY', m);
export const certError = (m) => new LError('E_CERT', m);
export const pendingError = (m) => new LError('E_PENDING', m);
