export const EXIT = Object.freeze({
  VALIDATION: 2,
  INVALID_DATE: 25,
  UNTRUSTED_INSTITUTION: 26,
  REINSTATEMENT_CYCLE: 27,
});

export class MetrologyError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'MetrologyError';
    this.exitCode = exitCode;
  }
}

export function validation(message) {
  return new MetrologyError(message, EXIT.VALIDATION);
}
