export class PlanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
