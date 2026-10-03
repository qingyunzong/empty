export const E_IO = 'E_IO';
export const E_SEQ = 'E_SEQ';
export const E_RANGE = 'E_RANGE';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const ioError = (msg) => new StoreError(E_IO, msg);
export const seqError = (msg) => new StoreError(E_SEQ, msg);
export const rangeError = (msg) => new StoreError(E_RANGE, msg);
