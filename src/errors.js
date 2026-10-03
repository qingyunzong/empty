export const E_CYCLE = 'E_CYCLE';
export const E_TIME = 'E_TIME';
export const E_PROOF = 'E_PROOF';
export const E_INPUT = 'E_INPUT';

export class LineageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LineageError';
    this.code = code;
  }
}
