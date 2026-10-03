export const E_LINEAR = 'E_LINEAR';
export const E_PENDING = 'E_PENDING';
export const E_BOUND = 'E_BOUND';
export const E_TYPE = 'E_TYPE';

export class LimError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LimError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function exitCodeFor(code) {
  switch (code) {
    case E_LINEAR: return 1;
    case E_TYPE: return 2;
    case E_BOUND: return 3;
    case E_PENDING: return 4;
    default: return 70;
  }
}
