export const EXIT = Object.freeze({
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  TIME_BACKWARDS: 5,
  NEGATIVE_CAPABILITY: 6,
  UNKNOWN_MATERIAL: 7,
});

export class GateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}
