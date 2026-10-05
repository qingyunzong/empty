export class ParseError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`ParseError at ${line}:${col}: ${message}`);
    this.name = 'ParseError';
  }
}

export class ScriptRuntimeError extends Error {
  constructor(message: string) {
    super(`ScriptRuntimeError: ${message}`);
    this.name = 'ScriptRuntimeError';
  }
}

export class BudgetExhaustedError extends Error {
  constructor(readonly stepsUsed: number, readonly budget: number) {
    super(`BudgetExhaustedError: step budget ${budget} exhausted after ${stepsUsed} steps`);
    this.name = 'BudgetExhaustedError';
  }
}
