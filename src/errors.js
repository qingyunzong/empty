export const ERR = Object.freeze({
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  ALREADY_UNDONE: 'ALREADY_UNDONE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  DUPLICATE_NODE: 'DUPLICATE_NODE',
  CORRUPT_STATE: 'CORRUPT_STATE',
  BAD_REQUEST: 'BAD_REQUEST',
});

export class UndoError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'UndoError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
