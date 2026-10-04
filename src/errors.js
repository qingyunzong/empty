export class RouteError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const E = {
  CONFLICT: 'E_CONFLICT',
  CYCLE: 'E_CYCLE',
  CAPACITY: 'E_CAPACITY',
  CORRUPT: 'E_CORRUPT',
  NO_PATH: 'E_NO_PATH',
  NOT_FOUND: 'E_NOT_FOUND',
  INVALID: 'E_INVALID',
};
