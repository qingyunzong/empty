export const E_LIMIT = 'E_LIMIT';
export const E_TIE = 'E_TIE';
export const E_STATE = 'E_STATE';

export class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}
