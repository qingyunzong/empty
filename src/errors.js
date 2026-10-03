export class SchedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SchedError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class BudgetError extends SchedError {
  constructor(message, details) {
    super('E_BUDGET', message, details);
    this.name = 'BudgetError';
  }
}

export class NoPlanError extends SchedError {
  constructor(message, details) {
    super('E_NO_PLAN', message, details);
    this.name = 'NoPlanError';
  }
}
