export class LimError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const EXIT_CODES = {
  OK: 0,
  E_LINEAR: 2,
  E_PENDING: 3,
  E_BOUND: 4,
  E_TYPE: 5,
};
