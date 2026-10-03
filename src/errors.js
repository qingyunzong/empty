export const CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  CYCLIC_ROUTE: 'CYCLIC_ROUTE',
  CALENDAR_OVERLAP: 'CALENDAR_OVERLAP',
  INFEASIBLE: 'INFEASIBLE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_STATE: 'INVALID_STATE',
});

export class PlanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
