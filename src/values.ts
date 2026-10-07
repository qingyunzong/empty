/** Script values: only plain data. No host objects, functions, or prototypes. */
export type Value = number | string | boolean | null | Value[] | Dict;

/** Dicts are null-prototype objects: no inherited host properties exist. */
export interface Dict {
  [key: string]: Value;
}

export function makeDict(): Dict {
  return Object.create(null) as Dict;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

export class ParseError extends ScriptError {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Thrown when the step budget is exhausted. Any unclosed state is
 *  abandoned in place; buffered writes are never published. */
export class BudgetExhausted extends ScriptError {
  constructor(public readonly limit: number) {
    super(`step budget exhausted (limit ${limit})`);
    this.name = 'BudgetExhausted';
  }
}
