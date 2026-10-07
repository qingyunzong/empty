export const E_DICT = 'E_DICT';
export const E_CRC = 'E_CRC';
export const E_DICTREF = 'E_DICTREF';
export const E_FORMAT = 'E_FORMAT';
export const E_MANIFEST = 'E_MANIFEST';
export const E_ARG = 'E_ARG';

export class PackError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    Object.assign(this, extra);
  }
}
