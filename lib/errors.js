export const E = Object.freeze({
  TZ_UNKNOWN: 'E_TZ_UNKNOWN',
  GAP: 'E_GAP',
  OVERLAP: 'E_OVERLAP',
  ORDER: 'E_ORDER',
});

export class ClearingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const EXIT_CODES = Object.freeze({
  [E.TZ_UNKNOWN]: 10,
  [E.GAP]: 11,
  [E.OVERLAP]: 12,
  [E.ORDER]: 13,
});
