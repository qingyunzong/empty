// Error codes required by the spec, plus E_INPUT for malformed input data.
export const CODES = Object.freeze({
  E_INPUT: 2,
  E_TZ_UNKNOWN: 3,
  E_GAP: 4,
  E_OVERLAP: 5,
  E_ORDER: 6,
});

export class ClearingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
    this.exitCode = CODES[code] ?? 1;
    if (details !== undefined) this.details = details;
  }
}

export const errInput = (msg, details) => new ClearingError('E_INPUT', msg, details);
export const errTzUnknown = (msg, details) => new ClearingError('E_TZ_UNKNOWN', msg, details);
export const errGap = (msg, details) => new ClearingError('E_GAP', msg, details);
export const errOverlap = (msg, details) => new ClearingError('E_OVERLAP', msg, details);
export const errOrder = (msg, details) => new ClearingError('E_ORDER', msg, details);
