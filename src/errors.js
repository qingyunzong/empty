export class SyncError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const EXIT_CODES = {
  VALIDATION: 2,
  ROLLBACK: 3,
  CONFLICT: 11,
};
