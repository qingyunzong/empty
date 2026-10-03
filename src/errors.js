export class OvenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OvenError';
    this.code = code;
  }
}

export const E_CONFIG = 'E_CONFIG';
export const E_RATIONAL = 'E_RATIONAL';
export const E_AMBIGUOUS = 'E_AMBIGUOUS';
export const E_STATE = 'E_STATE';

export function configError(message) {
  return new OvenError(E_CONFIG, message);
}

export function rationalError(message) {
  return new OvenError(E_RATIONAL, message);
}

export function ambiguousError(message) {
  return new OvenError(E_AMBIGUOUS, message);
}

export function stateError(message) {
  return new OvenError(E_STATE, message);
}
