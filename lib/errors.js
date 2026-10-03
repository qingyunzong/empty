export const ERR_INVALID_INPUT = 2;
export const ERR_OVERLAP_NO_PRIORITY = 40;
export const ERR_TIME_REVERSED = 41;

export class FeeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeeError';
    this.code = code;
  }
}
