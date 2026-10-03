export class PlanError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'PlanError';
    this.code = code;
  }
}
