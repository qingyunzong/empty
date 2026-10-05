export const EXIT = Object.freeze({
  OK: 0,
  VALIDATION: 2,
  BUDGET_EXCEEDED: 12,
  ILLEGAL_TRANSITION: 13,
  CONFLICT: 14,
});

export class ReplayError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ReplayError';
    this.kind = kind;
    this.details = details;
    this.exitCode = EXIT[kind] ?? 1;
  }
}
