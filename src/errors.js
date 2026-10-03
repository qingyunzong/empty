export const E_PARSE = 'E_PARSE';
export const E_TYPE = 'E_TYPE';
export const E_NON_EQUIV = 'E_NON_EQUIV';
export const E_UNSUPPORTED = 'E_UNSUPPORTED';

export class LakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LakeError';
    this.code = code;
  }
}

export const parseError = (m) => new LakeError(E_PARSE, m);
export const typeError = (m) => new LakeError(E_TYPE, m);
export const unsupported = (m) => new LakeError(E_UNSUPPORTED, m);
export const nonEquiv = (m) => new LakeError(E_NON_EQUIV, m);
