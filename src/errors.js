export class SchedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
  }
}

export const EXIT_CODES = {
  E_BUDGET: 10,
  E_PRECEDENCE: 11,
  E_CRC: 12,
  E_DIVERGED: 13,
};
