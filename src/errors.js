export class SchedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
  }
}

export const CODES = {
  E_BUDGET: 'E_BUDGET',
  E_PRECEDENCE: 'E_PRECEDENCE',
  E_CRC: 'E_CRC',
  E_DIVERGED: 'E_DIVERGED',
  E_STATE: 'E_STATE',
  E_USAGE: 'E_USAGE',
  E_IO: 'E_IO',
};

export function err(code, message) {
  return new SchedError(code, message);
}
