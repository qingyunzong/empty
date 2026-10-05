import { BudgetExhaustedError } from './errors';

export class Budget {
  private remaining: number | null;

  constructor(limit: number | null = null) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error(`budget limit must be a non-negative safe integer, got ${String(limit)}`);
    }
    this.remaining = limit;
  }

  charge(cost = 1): void {
    if (this.remaining === null) {
      return;
    }
    if (this.remaining < cost) {
      throw new BudgetExhaustedError();
    }
    this.remaining -= cost;
  }

  get left(): number | null {
    return this.remaining;
  }
}
