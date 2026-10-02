export const EXIT_CODES = {
  ATOMIC_SPLIT: 10,
  WINDOW_FULL: 11,
  QUOTA: 12,
  PARTIAL_COMMIT: 13,
};

export class ClearingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClearingError';
    this.code = code;
  }
}
