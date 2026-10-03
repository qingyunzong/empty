export class FeeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const lexError = (msg) => new FeeError('E_LEX', msg);
export const parseError = (msg) => new FeeError('E_PARSE', msg);
export const typeError = (msg) => new FeeError('E_TYPE', msg);
export const tierError = (msg) => new FeeError('E_TIER', msg);
export const roundError = (msg) => new FeeError('E_ROUND', msg);
export const conserveError = (msg) => new FeeError('E_CONSERVE', msg);
