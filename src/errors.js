export class DqError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DqError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const RULE_CYCLE = 'RULE_CYCLE';
export const NO_FEASIBLE = 'NO_FEASIBLE';
export const HISTORY_CONFLICT = 'HISTORY_CONFLICT';
export const SEARCH_LIMIT = 'SEARCH_LIMIT';
export const BAD_INPUT = 'BAD_INPUT';
