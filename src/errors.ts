/** Base class for every evaluation diagnostic. */
export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A thunk was forced while its own evaluation was still in progress. */
export class BlackHoleError extends EvalError {
  constructor(label: string) {
    super(`black hole: "${label}" depends on itself`);
  }
}

export class UnboundVariableError extends EvalError {
  constructor(name: string) {
    super(`unbound variable: ${name}`);
  }
}

export class DivisionByZeroError extends EvalError {
  constructor() {
    super('division by zero');
  }
}

/**
 * Control-flow failure: never cached on a thunk. A node that runs out of
 * budget stays unevaluated so evaluation can resume after topping up.
 */
export class BudgetExhaustedError extends EvalError {
  constructor() {
    super('evaluation budget exhausted');
  }
}
