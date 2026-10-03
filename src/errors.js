export class CorpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorpError';
    this.code = code;
  }
}

export const E_LOT = 'E_LOT';
export const E_RATIO = 'E_RATIO';
export const E_DATE = 'E_DATE';
export const E_REVERSE = 'E_REVERSE';
export const E_SYNTAX = 'E_SYNTAX';
