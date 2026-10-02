export class ReplanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReplanError';
    this.code = code;
    this.details = details;
  }
}

export const EXIT_CODES = {
  E_CYCLE: 2,
  E_BUDGET: 3,
  E_LOST_CKPT: 4,
  E_AMBIG: 5,
  E_INPUT: 6,
  SIM_CRASH: 75,
  E_USAGE: 64,
};
