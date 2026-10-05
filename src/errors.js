export class InvalidHistory extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidHistory';
  }
}

export class PendingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PendingError';
  }
}

export class ConflictError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ConflictError';
    this.detail = detail;
  }
}

export class Budget {
  constructor(limit = 1_000_000) {
    this.limit = limit;
    this.steps = 0;
  }
  step(n = 1) {
    this.steps += n;
    if (this.steps > this.limit) {
      throw new PendingError(`cycle/topology budget exhausted after ${this.steps} steps (limit ${this.limit})`);
    }
  }
}
