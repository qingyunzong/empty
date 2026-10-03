export class PlannerError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    const out = { status: this.status, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function invalidInput(message, details) {
  return new PlannerError('INVALID_INPUT', message, details);
}
