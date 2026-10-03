export const CODES = Object.freeze({
  QUOTA: 'QUOTA',
  CORRUPT: 'CORRUPT',
  SEQ_GAP: 'SEQ_GAP',
  READONLY: 'READONLY',
});

export class LogError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LogError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
