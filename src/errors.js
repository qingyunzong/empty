export const CODES = Object.freeze({
  SEALED: 'SEALED',
  CONFLICT_DOMAIN: 'CONFLICT_DOMAIN',
  NO_SLOT: 'NO_SLOT',
  BAD_DIFF: 'BAD_DIFF',
});

export class ReconError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReconError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
