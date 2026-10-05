export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  BUDGET: 12,
  TRANSITION: 13,
  CONFLICT: 14,
});

export class ReplayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
    this.details = details;
  }
}
