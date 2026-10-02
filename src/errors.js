export class ReplanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReplanError';
    this.code = code;
  }
}

export const EXIT_CODES = {
  E_CYCLE: 2,
  E_BUDGET: 3,
  E_LOST_CKPT: 4,
  E_AMBIG: 5,
  E_UNKNOWN: 6,
  E_CRASH: 10,
  E_USAGE: 64,
};
