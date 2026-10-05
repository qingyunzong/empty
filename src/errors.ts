export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionError';
  }
}

export class BudgetExhaustedError extends Error {
  constructor(message = 'operation budget exhausted') {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export class IntegerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegerError';
  }
}
